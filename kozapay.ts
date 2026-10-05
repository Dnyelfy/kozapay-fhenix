// KozaPay on Fhenix CoFHE: wallet, encryption and contract calls.
// Stack: viem + @cofhe/sdk (the successor of the retired cofhejs).

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/web";
import { arbSepolia } from "@cofhe/sdk/chains";
import { Encryptable, FheTypes } from "@cofhe/sdk";
import { KOZAPAY_ABI, KOZAPAY_BYTECODE } from "./kozapayArtifact";

// ---- config -----------------------------------------------------------------
// Set this to the address printed by the deploy panel, then redeploy the site.
// While it is empty, the app shows the one-time deploy panel instead.
export const KOZAPAY_ADDRESS = "0xa9f5e0819399938e953be5361fb6843456a32204" as Address | "";

export const CHAIN = arbitrumSepolia;
export const EXPLORER = "https://sepolia.arbiscan.io";
export const MAX_PAYROLL = 20;

// ---- session ------------------------------------------------------------------
export type Session = {
  account: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  cofhe: ReturnType<typeof createCofheClient>;
};

function eth(): any {
  const e = (window as any).ethereum;
  if (!e) throw new Error("No wallet found. Install MetaMask or another EVM wallet.");
  return e;
}

async function ensureChain(walletClient: WalletClient) {
  const current = await walletClient.getChainId();
  if (current === CHAIN.id) return;
  try {
    await walletClient.switchChain({ id: CHAIN.id });
  } catch (e: any) {
    // 4902: the wallet does not know this chain yet
    if (e?.code === 4902 || /unrecognized|not been added|4902/i.test(String(e?.message))) {
      await walletClient.addChain({ chain: CHAIN });
      await walletClient.switchChain({ id: CHAIN.id });
    } else {
      throw e;
    }
  }
}

export async function connectWallet(onStep?: (s: string) => void): Promise<Session> {
  const provider = eth();
  const walletClient = createWalletClient({ chain: CHAIN, transport: custom(provider) });
  const [account] = await walletClient.requestAddresses();
  if (!account) throw new Error("No account selected.");
  onStep?.("switching to Arbitrum Sepolia");
  await ensureChain(walletClient);
  const wallet = createWalletClient({ account, chain: CHAIN, transport: custom(provider) });
  const publicClient = createPublicClient({ chain: CHAIN, transport: http() }) as PublicClient;

  onStep?.("starting the FHE client");
  const cofhe = createCofheClient(createCofheConfig({ supportedChains: [arbSepolia] }));
  await cofhe.connect(publicClient, wallet);
  onStep?.("sign the viewing permission in your wallet");
  await cofhe.acp.getOrCreateSelfACP();
  return { account, publicClient, walletClient: wallet, cofhe };
}

// ---- helpers ------------------------------------------------------------------
// Arbitrum Sepolia's base fee can jump between the estimate and the block, which makes
// the wallet's fee too low ("max fee per gas less than block base fee"). Give the max
// fee generous headroom; only the actual base fee is charged, the rest is never spent.
async function fees(s: Session) {
  const block = await s.publicClient.getBlock();
  const base = block.baseFeePerGas ?? 0n;
  const est = await s.publicClient.estimateFeesPerGas().catch(() => null);
  const priority = est?.maxPriorityFeePerGas ?? 0n;
  const fromEst = est?.maxFeePerGas ?? 0n;
  const floor = base * 3n + priority;
  const maxFeePerGas = fromEst * 2n > floor ? fromEst * 2n : floor;
  return { maxFeePerGas, maxPriorityFeePerGas: priority };
}

function addr(): Address {
  if (!KOZAPAY_ADDRESS) throw new Error("Contract address is not set yet.");
  return KOZAPAY_ADDRESS;
}

async function write(s: Session, functionName: string, args: any[] = [], value?: bigint) {
  const { request } = await s.publicClient.simulateContract({
    address: addr(),
    abi: KOZAPAY_ABI,
    functionName: functionName as any,
    args: args as any,
    account: s.account,
    value,
  } as any);
  const hash = await s.walletClient.writeContract({ ...(request as any), ...(await fees(s)) });
  const receipt = await s.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction failed: " + hash);
  return hash;
}

async function read<T>(s: Session, functionName: string, args: any[] = []): Promise<T> {
  return (await s.publicClient.readContract({
    address: addr(),
    abi: KOZAPAY_ABI,
    functionName: functionName as any,
    args: args as any,
  } as any)) as T;
}

export type Progress = (message: string) => void;

const STEP_TEXT: Record<string, string> = {
  initTfhe: "preparing encryption",
  fetchKeys: "downloading Fhenix keys",
  pack: "encrypting the amount",
  prove: "building the proof (can take 1-2 minutes, keep this tab open)",
  verify: "Fhenix is checking the proof",
};

async function encrypt(s: Session, amounts: bigint[], onProgress?: Progress) {
  const items = amounts.map((a) => Encryptable.uint128(a));
  const out = (await s.cofhe
    .encryptInputs(items)
    .setConsumingContract(addr())
    .onStep((step: string, ctx?: { isStart?: boolean }) => {
      if (ctx?.isStart && STEP_TEXT[step]) onProgress?.(STEP_TEXT[step]);
    })
    .execute()) as unknown as Hex[];
  const proof = out[out.length - 1];
  const hashes = out.slice(0, -1);
  return { hashes, proof };
}

const isEmpty = (h: Hex) => /^0x0*$/.test(h);

async function decryptHandle(s: Session, handle: Hex): Promise<bigint> {
  if (isEmpty(handle)) return 0n;
  const v = await s.cofhe.decryptForView(handle, FheTypes.Uint128).withACP().execute();
  return BigInt(v as any);
}

// ---- actions -------------------------------------------------------------------
export function deposit(s: Session, wei: bigint) {
  return write(s, "deposit", [], wei);
}

export async function send(s: Session, to: Address, wei: bigint, onProgress?: Progress) {
  const { hashes, proof } = await encrypt(s, [wei], onProgress);
  onProgress?.("confirm the transaction in your wallet");
  return write(s, "send", [to, hashes[0], proof]);
}

export async function payroll(s: Session, to: Address[], weis: bigint[], onProgress?: Progress) {
  if (to.length !== weis.length) throw new Error("Each line needs an address and an amount.");
  if (to.length === 0 || to.length > MAX_PAYROLL) throw new Error(`Payroll takes 1 to ${MAX_PAYROLL} recipients.`);
  const { hashes, proof } = await encrypt(s, weis, onProgress);
  onProgress?.("confirm the transaction in your wallet");
  return write(s, "payroll", [to, hashes, proof]);
}

export const claim = (s: Session, id: bigint) => write(s, "claim", [id]);
export const recall = (s: Session, id: bigint) => write(s, "recall", [id]);

export const requestWithdraw = (s: Session, wei: bigint) => write(s, "requestWithdraw", [wei]);

export async function finalizeWithdraw(s: Session) {
  const handle = await read<Hex>(s, "pendingWithdrawOf", [s.account]);
  const r = await s.cofhe.decryptForTx(handle).withACP().execute();
  await write(s, "finalizeWithdraw", [r.decryptedValue, r.signature]);
  return r.decryptedValue;
}

// ---- reads ---------------------------------------------------------------------
export async function myBalance(s: Session) {
  return decryptHandle(s, await read<Hex>(s, "encBalanceOf", [s.account]));
}

export const hasPendingWithdraw = (s: Session) => read<boolean>(s, "hasPendingWithdraw", [s.account]);

export type PaymentRow = {
  id: bigint;
  from: Address;
  to: Address;
  handle: Hex;
  createdAt: number;
  claimed: boolean;
  recalled: boolean;
};

export async function myPayments(s: Session): Promise<PaymentRow[]> {
  const count = await read<bigint>(s, "paymentsCount");
  const me = s.account.toLowerCase();
  const rows: PaymentRow[] = [];
  const start = count > 200n ? count - 200n : 0n; // newest 200 payments
  for (let i = count - 1n; i >= start && i >= 0n; i--) {
    const p = await read<[Address, Address, Hex, bigint, boolean, boolean]>(s, "payments", [i]);
    if (p[0].toLowerCase() !== me && p[1].toLowerCase() !== me) continue;
    rows.push({ id: i, from: p[0], to: p[1], handle: p[2], createdAt: Number(p[3]), claimed: p[4], recalled: p[5] });
    if (i === 0n) break;
  }
  return rows;
}

export const paymentAmount = (s: Session, row: PaymentRow) => decryptHandle(s, row.handle);

// ---- one-time deploy -------------------------------------------------------------
export async function deployKozaPay(s: Session): Promise<Address> {
  const hash = await s.walletClient.deployContract({
    abi: KOZAPAY_ABI,
    bytecode: KOZAPAY_BYTECODE,
    account: s.account,
    chain: CHAIN,
    ...(await fees(s)),
  } as any);
  const receipt = await s.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deploy failed: " + hash);
  return receipt.contractAddress;
}
