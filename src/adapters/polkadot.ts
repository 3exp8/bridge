import { Storage } from "@acala-network/sdk/utils/storage";
import { AnyApi, FixedPointNumber as FN } from "@acala-network/sdk-core";
import { combineLatest, map, Observable } from "rxjs";

import { SubmittableExtrinsic } from "@polkadot/api/types";
import { DeriveBalancesAll } from "@polkadot/api-derive/balances/types";
import { ISubmittableResult } from "@polkadot/types/types";

import { BalanceAdapter, BalanceAdapterConfigs } from "../balance-adapter";
import { BaseCrossChainAdapter } from "../base-chain-adapter";
import { ChainName, chains } from "../configs";
import { ApiNotFound, CurrencyNotFound } from "../errors";
import {
  BalanceData,
  BasicToken,
  CrossChainRouterConfigs,
  CrossChainTransferParams,
} from "../types";

export const polkadotRoutersConfig: Omit<CrossChainRouterConfigs, "from">[] = [
  {
    to: "acala",
    token: "DOT",
    xcm: { fee: { token: "DOT", amount: "3549633" }, weightLimit: "Unlimited" },
  },
];
export const kusamaRoutersConfig: Omit<CrossChainRouterConfigs, "from">[] = [
  {
    to: "karura",
    token: "KSM",
    xcm: {
      fee: { token: "KSM", amount: "64000000" },
      weightLimit: "Unlimited",
    },
  },
  {
    to: "basilisk",
    token: "KSM",
    xcm: {
      fee: { token: "KSM", amount: "51618187" },
      weightLimit: "Unlimited",
    },
  },
  {
    to: "statemine",
    token: "KSM",
    xcm: {
      fee: { token: "KSM", amount: "4000000000" },
      weightLimit: "Unlimited",
    },
  },
];

const polkadotTokensConfig: Record<string, Record<string, BasicToken>> = {
  polkadot: {
    DOT: { name: "DOT", symbol: "DOT", decimals: 10, ed: "10000000000" },
  },
  kusama: {
    KSM: { name: "KSM", symbol: "KSM", decimals: 12, ed: "79999999" },
  },
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
const createBalanceStorages = (api: AnyApi) => {
  return {
    balances: (address: string) =>
      Storage.create<DeriveBalancesAll>({
        api,
        path: "derive.balances.all",
        params: [address],
      }),
  };
};

class PolkadotBalanceAdapter extends BalanceAdapter {
  private storages: ReturnType<typeof createBalanceStorages>;

  constructor({ api, chain, tokens }: BalanceAdapterConfigs) {
    super({ chain, api, tokens });

    this.storages = createBalanceStorages(api);
  }

  public subscribeBalance(
    token: string,
    address: string
  ): Observable<BalanceData> {
    const storage = this.storages.balances(address);

    if (token !== this.nativeToken) {
      throw new CurrencyNotFound(token);
    }

    return storage.observable.pipe(
      map((data) => ({
        free: FN.fromInner(data.freeBalance.toString(), this.decimals),
        locked: FN.fromInner(data.lockedBalance.toString(), this.decimals),
        reserved: FN.fromInner(data.reservedBalance.toString(), this.decimals),
        available: FN.fromInner(
          data.availableBalance.toString(),
          this.decimals
        ),
      }))
    );
  }
}

class BasePolkadotAdapter extends BaseCrossChainAdapter {
  private balanceAdapter?: PolkadotBalanceAdapter;

  public override async setApi(api: AnyApi) {
    this.api = api;

    await api.isReady;

    const chain = this.chain.id as ChainName;

    this.balanceAdapter = new PolkadotBalanceAdapter({
      chain,
      api,
      tokens: polkadotTokensConfig[chain],
    });
  }

  public subscribeTokenBalance(
    token: string,
    address: string
  ): Observable<BalanceData> {
    if (!this.balanceAdapter) {
      throw new ApiNotFound(this.chain.id);
    }

    return this.balanceAdapter.subscribeBalance(token, address);
  }

  public subscribeMaxInput(
    token: string,
    address: string,
    to: ChainName
  ): Observable<FN> {
    if (!this.balanceAdapter) {
      throw new ApiNotFound(this.chain.id);
    }

    return combineLatest({
      txFee: this.estimateTxFee({
        amount: FN.ZERO,
        to,
        token,
        address,
        signer: address,
      }),
      balance: this.balanceAdapter
        .subscribeBalance(token, address)
        .pipe(map((i) => i.available)),
    }).pipe(
      map(({ balance, txFee }) => {
        const tokenMeta = this.balanceAdapter?.getToken(token);
        const feeFactor = 1.2;
        const fee = FN.fromInner(txFee, tokenMeta?.decimals).mul(
          new FN(feeFactor)
        );

        // always minus ed
        return balance
          .minus(fee)
          .minus(FN.fromInner(tokenMeta?.ed || "0", tokenMeta?.decimals));
      })
    );
  }

  public createTx(
    params: CrossChainTransferParams
  ):
    | SubmittableExtrinsic<"promise", ISubmittableResult>
    | SubmittableExtrinsic<"rxjs", ISubmittableResult> {
    if (this.api === undefined) {
      throw new ApiNotFound(this.chain.id);
    }

    const { address, amount, to, token } = params;
    const toChain = chains[to];

    if (token !== this.balanceAdapter?.nativeToken) {
      throw new CurrencyNotFound(token);
    }

    const accountId = this.api?.createType("AccountId32", address).toHex();

    // to statemine
    if (to === "statemine" || to === "statemint") {
      const dst = {
        interior: { X1: { ParaChain: toChain.paraChainId } },
        parents: 0,
      };
      const acc = {
        interior: { X1: { AccountId32: { id: accountId, network: "Any" } } },
        parents: 0,
      };
      const ass = [
        {
          fun: { Fungible: amount.toChainData() },
          id: { Concrete: { interior: "Here", parents: 0 } },
        },
      ];

      return this.api?.tx.xcmPallet.limitedTeleportAssets(
        { V1: dst },
        { V1: acc },
        { V1: ass },
        0,
        "Unlimited"
      );
    }

    // to karura/acala
    if (to === "acala" || to === "karura") {
      const dst = { X1: { Parachain: toChain.paraChainId } };
      const acc = { X1: { AccountId32: { id: accountId, network: "Any" } } };
      const ass = [{ ConcreteFungible: { amount: amount.toChainData() } }];

      return this.api?.tx.xcmPallet.reserveTransferAssets(
        { V0: dst },
        { V0: acc },
        { V0: ass },
        0
      );
    }

    // to other parachain
    const dst = { X1: { Parachain: toChain.paraChainId } };
    const acc = { X1: { AccountId32: { id: accountId, network: "Any" } } };
    const ass = [{ ConcreteFungible: { amount: amount.toChainData() } }];

    return this.api?.tx.xcmPallet.limitedReserveTransferAssets(
      { V0: dst },
      { V0: acc },
      { V0: ass },
      0,
      this.getDestWeight(token, to)?.toString()
    );
  }
}

export class PolkadotAdapter extends BasePolkadotAdapter {
  constructor() {
    super(
      chains.polkadot,
      polkadotRoutersConfig,
      polkadotTokensConfig.polkadot
    );
  }
}

export class KusamaAdapter extends BasePolkadotAdapter {
  constructor() {
    super(chains.kusama, kusamaRoutersConfig, polkadotTokensConfig.kusama);
  }
}
