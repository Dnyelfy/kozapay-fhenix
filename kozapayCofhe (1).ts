// KozaPay on CoFHE - frontend integration (ethers v6 + cofhejs)
// Drop-in for the existing koza-pay frontend. Replaces the Zama relayer-sdk layer.
//
// install: pnpm add cofhejs ethers
// Confirm exact init/method names against your installed cofhejs version
// (the SDK is under active development - pin the version in package.json).

import { ethers } from "ethers";
import { cofhejs, Encryptable, FheTypes } from "cofhejs/web";

// ---- config ---------------------------------------------------------------
export const KOZAPAY_ADDRESS = "0x1C68d18F2C7A4fb694633B4815AE5E5153Dd59Da"; // Arbitrum Sepolia
// Arbitrum Sepolia native USDC (Circle). Verify on developers.circle.com before mainnet.
export const USDC_ADDRESS = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

// Minimal ABI (only what the UI calls)
export const KOZAPAY_ABI = [
  "function deposit(uint128 amount)",
  "function send(address to, (uint256 ctHash, uint256 securityZone, uint8 utype, bytes signature) encAmount) returns (uint256)",
  "function payroll(address[] recipients, (uint256 ctHash, uint256 securityZone, uint8 utype, bytes signature)[] encAmounts) returns (uint256)",
  "function claim(uint256 id)",
  "function recall(uint256 id)",
  "function requestWithdraw(uint128 amount)",
  "function finalizeWithdraw()",
  "function encBalanceOf(address user) view returns (uint256)",
  "function paymentAmount(uint256 id) view returns (uint256)",
  "function paymentsCount() view returns (uint256)",
  "function payments(uint256) view returns (address from, address to, uint256 amount, uint64 createdAt, bool claimed, bool recalled)",
  "event PaymentCreated(uint256 indexed id, address indexed from, address indexed to)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

// ---- init -----------------------------------------------------------------
// Call once after wallet connect. environment: "TESTNET" for Sepolia chains,
// "MOCK" for local hardhat, "MAINNET" when CoFHE mainnet ships.
export async function initCofhe(signer: ethers.Signer, provider: ethers.Provider) {
  const res = await cofhejs.initializeWithEthers({
    ethersProvider: provider,
    ethersSigner: signer,
    environment: "TESTNET",
  });
  if (!res.success) throw new Error(`cofhejs init failed: ${res.error}`);

  // Self-permit lets the connected user unseal values allowed to them.
  const permit = await cofhejs.createPermit({ type: "self", issuer: await signer.getAddress() });
  if (!permit.success) throw new Error(`permit failed: ${permit.error}`);
  return permit.data;
}

function contract(signer: ethers.Signer) {
  return new ethers.Contract(KOZAPAY_ADDRESS, KOZAPAY_ABI, signer);
}

// USDC is 6 decimals -> use parseUnits(x, 6). Amounts fit euint128.
async function encrypt(amountWei: bigint) {
  const res = await cofhejs.encrypt((_step) => {}, [Encryptable.uint128(amountWei)]);
  if (!res.success) throw new Error(`encrypt failed: ${res.error}`);
  return res.data[0]; // InEuint128 struct
}

// ---- on-ramp --------------------------------------------------------------
export async function deposit(signer: ethers.Signer, amountWei: bigint) {
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
  await (await usdc.approve(KOZAPAY_ADDRESS, amountWei)).wait();
  return contract(signer).deposit(amountWei); // deposit amount is public (the on-ramp)
}

// ---- confidential send / payroll ------------------------------------------
export async function send(signer: ethers.Signer, to: string, amountWei: bigint) {
  const enc = await encrypt(amountWei);
  return contract(signer).send(to, enc);
}

export async function payroll(
  signer: ethers.Signer,
  recipients: string[],
  amountsWei: bigint[]
) {
  if (recipients.length !== amountsWei.length) throw new Error("length mismatch");
  if (recipients.length === 0 || recipients.length > 20) throw new Error("1..20 recipients");
  const encAmounts = [];
  for (const a of amountsWei) encAmounts.push(await encrypt(a));
  return contract(signer).payroll(recipients, encAmounts);
}

export async function claim(signer: ethers.Signer, id: number) {
  return contract(signer).claim(id);
}

export async function recall(signer: ethers.Signer, id: number) {
  return contract(signer).recall(id);
}

// ---- off-ramp (async decrypt) ---------------------------------------------
export async function requestWithdraw(signer: ethers.Signer, amountWei: bigint) {
  return contract(signer).requestWithdraw(amountWei);
}

// Poll then finalize once CoFHE has posted the decryption result on-chain.
export async function finalizeWithdraw(signer: ethers.Signer) {
  return contract(signer).finalizeWithdraw();
}

// ---- reads (unseal encrypted handles client-side) -------------------------
// Each returns the plaintext bigint ONLY if the connected wallet is allowed
// on that handle (balance owner, or the specific payroll recipient).
export async function unsealBalance(signer: ethers.Signer, user: string): Promise<bigint> {
  const ctHash: bigint = await contract(signer).encBalanceOf(user);
  const res = await cofhejs.unseal(ctHash, FheTypes.Uint128);
  if (!res.success) throw new Error(`unseal failed: ${res.error}`);
  return res.data as bigint;
}

export async function unsealPaymentAmount(signer: ethers.Signer, id: number): Promise<bigint> {
  const ctHash: bigint = await contract(signer).paymentAmount(id);
  const res = await cofhejs.unseal(ctHash, FheTypes.Uint128);
  if (!res.success) throw new Error(`unseal failed: ${res.error}`);
  return res.data as bigint;
}
