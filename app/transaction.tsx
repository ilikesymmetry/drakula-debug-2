"use client";
import type {
  TransactionError,
  TransactionResponse,
} from "@coinbase/onchainkit/transaction";
import type { Address } from "viem";
import { formatUnits } from "viem";
import { buildSwapTransaction } from "@coinbase/onchainkit/api";
import {
  decodeFunctionData,
  erc20Abi,
  parseAbi,
  parseUnits,
  encodeFunctionData,
} from "viem";
import { base } from "viem/chains";
import { createCollectorClient } from "@zoralabs/protocol-sdk";
import { http, createPublicClient, fallback } from "viem";
import { useSendCalls } from "wagmi/experimental";

const publicClient = createPublicClient({
  chain: base,
  transport: http(),
});

const collectorClient = createCollectorClient({
  chainId: base.id,
  // @ts-ignore - publicClient is not typed correctly
  publicClient: publicClient,
});

const usdcToken = {
  name: "USDC",
  address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as `0x${string}`,
  symbol: "USDC",
  decimals: 6,
  image:
    "https://d3r81g40ycuhqg.cloudfront.net/wallet/wais/44/2b/442b80bd16af0c0d9b22e03a16753823fe826e5bfd457292b55fa0ba8c1ba213-ZWUzYjJmZGUtMDYxNy00NDcyLTg0NjQtMWI4OGEwYjBiODE2",
  chainId: 8453,
};

const UNIVERSALROUTER_CONTRACT_ADDRESS =
  "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";
const PERMINT2_CONTRACT_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const ethToken = {
  name: "ETH",
  address: "" as `0x${string}`,
  symbol: "ETH",
  decimals: 18,
  image:
    "https://wallet-api-production.s3.amazonaws.com/uploads/tokens/eth_288.png",
  chainId: 8453,
};

const getTxRequest = async (walletAddress: Address, quantityToMint: number) => {
  const calls = [];
  const priceInEth =
    parseUnits("0.000111", ethToken.decimals) * BigInt(quantityToMint);

  const simulateContractParameters = await collectorClient.mint({
    tokenContract: "0x973EfB3D59C2d46FbF1128eE147b737179C4b4C1",
    quantityToMint,
    mintType: "1155",
    minterAccount: walletAddress,
    tokenId: 3,
  });

  const buildSwapTxRequest = {
    fromAddress: walletAddress,
    from: usdcToken,
    to: ethToken,
    amount: formatUnits(priceInEth, ethToken.decimals),
    amountReference: "to",
    useAggregator: false,
  };

  const response = await buildSwapTransaction(buildSwapTxRequest);

  const { approveTransaction, transaction, quote } = response;

  if (approveTransaction?.data) {
    const approveTx = decodeFunctionData({
      abi: erc20Abi,
      data: approveTransaction?.data,
    });

    // Add extra buffer to the approval for just in case the price changes. Adds extra 15%
    const approveAmountBuffer = (BigInt(quote.fromAmount) * BigInt(15)) / BigInt(100);
    const finalAmount = (approveTx.args[1] as bigint) + approveAmountBuffer;
    const newDecodedData = encodeFunctionData({
      abi: erc20Abi,
      functionName: approveTx.functionName,
      // @ts-ignore - args are present but not typed correctly
      args: [approveTx.args[0], finalAmount],
    });
    calls.push({
      to: approveTransaction.to,
      data: newDecodedData,
      value: approveTransaction.value,
    });

    const permint2ContractAbi = parseAbi([
      "function approve(address token, address spender, uint160 amount, uint48 expiration) external",
    ]);

    const data = encodeFunctionData({
      abi: permint2ContractAbi,
      functionName: "approve",
      args: [
        quote.from.address as `0x${string}`,
        UNIVERSALROUTER_CONTRACT_ADDRESS,
        finalAmount,
        20_000_000_000_000, // The deadline where the approval is no longer valid - see https://docs.uniswap.org/contracts/permit2/reference/allowance-transfer
      ],
    });

    calls.push({
      to: PERMINT2_CONTRACT_ADDRESS as `0x${string}`,
      data: data,
      value: 0n,
    });
  }

  calls.push({
    to: transaction.to,
    value: transaction.value,
    data: transaction.data,
  });

  calls.push({
    to: simulateContractParameters.parameters.address,
    data: encodeFunctionData({
      abi: simulateContractParameters.parameters.abi,
      functionName: simulateContractParameters.parameters.functionName,
      args: simulateContractParameters.parameters.args,
    }),
    value: simulateContractParameters.parameters.value,
  });

  return calls;
};

const PAYMASTER_URL = process.env.NEXT_PUBLIC_PAYMASTER_URL;

export default function TransactionWrapper({ address }: { address: Address }) {
  const { sendCalls } = useSendCalls();
  const handleClick = async () => {
    const txRequest = await getTxRequest(address, 1);
    const id = await sendCalls({
      calls: txRequest,
      capabilities: {
        paymasterService: {
          url: PAYMASTER_URL,
        },
      },
    });
    console.log("id", id);
  };

  return (
    <div className="flex w-[450px]">
      <button onClick={handleClick}>Transact</button>
    </div>
  );
}
