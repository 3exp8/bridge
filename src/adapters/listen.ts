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

const DEST_WEIGHT = "5000000000";

export const listenRoutersConfig: Omit<CrossChainRouterConfigs, "from">[] = [
  {
    to: "karura",
    token: "LT",
    xcm: {
      fee: { token: "LT", amount: "93240000000" },
      weightLimit: DEST_WEIGHT,
    },
  },
  {
    to: "karura",
    token: "KAR",
    xcm: {
      fee: { token: "KAR", amount: "9324000000" },
      weightLimit: DEST_WEIGHT,
    },
  },
  {
    to: "karura",
    token: "KUSD",
    xcm: {
      fee: { token: "KUSD", amount: "5693632140" },
      weightLimit: DEST_WEIGHT,
    },
  },
  {
    to: "karura",
    token: "LKSM",
    xcm: {
      fee: { token: "LKSM", amount: "739331668" },
      weightLimit: DEST_WEIGHT,
    },
  },
];

export const listenTokensConfig: Record<string, BasicToken> = {
  LT: { name: "LT", symbol: "LT", decimals: 12, ed: "500000000000" },
  KAR: { name: "KAR", symbol: "KAR", decimals: 12, ed: "100000000000" },
  KUSD: { name: "KUSD", symbol: "KUSD", decimals: 12, ed: "10000000000" },
  LKSM: { name: "LKSM", symbol: "LKSM", decimals: 12, ed: "500000000" },
};

const SUPPORTED_TOKENS: Record<string, number> = {
  LT: 0,
  KAR: 128,
  KUSD: 129,
  LKSM: 131,
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
    assets: (tokenId: number, address: string) =>
      Storage.create<any>({
        api,
        path: "query.tokens.accounts",
        params: [address, tokenId],
      }),
  };
};

class ListenBalanceAdapter extends BalanceAdapter {
  private storages: ReturnType<typeof createBalanceStorages>;

  constructor({ api, chain, tokens }: BalanceAdapterConfigs) {
    super({ api, chain, tokens });
    this.storages = createBalanceStorages(api);
  }

  public subscribeBalance(
    token: string,
    address: string
  ): Observable<BalanceData> {
    const storage = this.storages.balances(address);

    if (token === this.nativeToken) {
      return storage.observable.pipe(
        map((data) => ({
          free: FN.fromInner(data.freeBalance.toString(), this.decimals),
          locked: FN.fromInner(data.lockedBalance.toString(), this.decimals),
          reserved: FN.fromInner(
            data.reservedBalance.toString(),
            this.decimals
          ),
          available: FN.fromInner(
            data.availableBalance.toString(),
            this.decimals
          ),
        }))
      );
    }

    const tokenId = SUPPORTED_TOKENS[token];

    if (tokenId === undefined) {
      throw new CurrencyNotFound(token);
    }

    return this.storages.assets(tokenId, address).observable.pipe(
      map((balance) => {
        const amount = FN.fromInner(
          balance.free?.toString() || "0",
          this.getToken(token).decimals
        );

        return {
          free: amount,
          locked: new FN(0),
          reserved: new FN(0),
          available: amount,
        };
      })
    );
  }
}

class BaseListenAdapter extends BaseCrossChainAdapter {
  private balanceAdapter?: ListenBalanceAdapter;

  public override async setApi(api: AnyApi) {
    this.api = api;

    await api.isReady;

    this.balanceAdapter = new ListenBalanceAdapter({
      chain: this.chain.id as ChainName,
      api,
      tokens: listenTokensConfig,
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
      txFee:
        token === this.balanceAdapter?.nativeToken
          ? this.estimateTxFee({
              amount: FN.ZERO,
              to,
              token,
              address,
              signer: address,
            })
          : "0",
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

    const tokenId = SUPPORTED_TOKENS[token];

    if (tokenId === undefined) {
      throw new CurrencyNotFound(token);
    }

    const toChain = chains[to];
    const accountId = this.api?.createType("AccountId32", address).toHex();
    const dst = {
      parents: 1,
      interior: {
        X2: [
          { Parachain: toChain.paraChainId },
          { AccountId32: { id: accountId, network: "Any" } },
        ],
      },
    };

    return this.api?.tx.xTokens.transfer(
      tokenId,
      amount.toChainData(),
      { V1: dst },
      this.getDestWeight(token, to)?.toString()
    );
  }
}

export class ListenAdapter extends BaseListenAdapter {
  constructor() {
    super(chains.listen, listenRoutersConfig, listenTokensConfig);
  }
}
