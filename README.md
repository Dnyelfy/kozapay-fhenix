# KozaPay

Private ETH payments on Fhenix CoFHE (Arbitrum Sepolia).

- **Deposit:** move ETH into a private balance. The deposit amount is public; everything after it is encrypted.
- **Private send:** send an encrypted amount. You can recall it until the recipient claims it.
- **Private payroll:** pay up to 20 people in one transaction. Each recipient can decrypt only their own amount.
- **Withdraw:** set an amount aside, let the Fhenix threshold network decrypt and sign it, then receive the ETH.

Balances and payment amounts are stored on-chain as `euint128`. Only the balance owner, and the two sides of a payment, can decrypt them.

## Stack

- Contract: `contracts/KozaPay.sol`, built on `@fhenixprotocol/cofhe-contracts` 0.2.0
- App: React + Vite, `viem` and `@cofhe/sdk` 0.7.1

The contract was tested end to end against the CoFHE mock contracts (deposit, send and claim, recall, payroll, overspend, access control, and withdraw with a forged amount rejected).

## Deploy

1. Publish the site with `KOZAPAY_ADDRESS` empty in `kozapay.ts`. The app then shows a one-time deploy panel.
2. Connect a wallet on Arbitrum Sepolia and press **Deploy KozaPay**.
3. Put the printed address in `kozapay.ts` and publish again.

## Build

```
npm install
npm run build
```

## License

MIT
