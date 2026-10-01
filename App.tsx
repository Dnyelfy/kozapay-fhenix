import { useEffect, useRef, useState } from "react";
import { formatEther, isAddress, parseEther, type Address } from "viem";
import {
  KOZAPAY_ADDRESS,
  EXPLORER,
  MAX_PAYROLL,
  connectWallet,
  deposit,
  send,
  payroll,
  claim,
  recall,
  requestWithdraw,
  finalizeWithdraw,
  hasPendingWithdraw,
  myBalance,
  myPayments,
  paymentAmount,
  deployKozaPay,
  type PaymentRow,
  type Session,
} from "./kozapay";

const prefersReduced =
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function sealedGlyphs(len = 9) {
  const g = "▓▒░▚▞";
  let s = "";
  for (let i = 0; i < len; i++) s += g[Math.floor(Math.random() * g.length)];
  return s;
}

function Cipher({ value, big }: { value: string | null; big?: boolean }) {
  const [display, setDisplay] = useState<string>(() => sealedGlyphs(big ? 11 : 7));
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (value == null) {
      setDisplay(sealedGlyphs(big ? 11 : 7));
      return;
    }
    if (prefersReduced) {
      setDisplay(value);
      return;
    }
    const chars = "0123456789ABCDEF";
    let frame = 0;
    const target = value;
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => {
      frame++;
      const shown = Math.floor(frame / 2);
      let out = "";
      for (let i = 0; i < target.length; i++) {
        out += i < shown ? target[i] : chars[Math.floor(Math.random() * chars.length)];
      }
      setDisplay(out);
      if (shown >= target.length && timer.current) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
    }, 45);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [value, big]);

  return (
    <span className={"cipher" + (value == null ? " sealed" : "") + (big ? " big" : "")}>
      {display}
    </span>
  );
}

function toWei(x: string): bigint {
  const v = x.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(v)) throw new Error(`"${x}" is not a valid ETH amount.`);
  const w = parseEther(v);
  if (w <= 0n) throw new Error("Amount must be greater than 0.");
  return w;
}

function niceError(e: any): string {
  const m = String(e?.shortMessage ?? e?.reason ?? e?.message ?? e);
  if (/user rejected|denied/i.test(m)) return "you cancelled it in your wallet";
  if (/insufficient funds/i.test(m)) return "not enough ETH for this and gas";
  return m.split("\n")[0].slice(0, 180);
}

const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);

export default function App() {
  const [s, setS] = useState<Session | null>(null);
  const [status, setStatus] = useState("waiting for wallet");
  const [busy, setBusy] = useState(false);

  const [depositAmt, setDepositAmt] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [payrollText, setPayrollText] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [pending, setPending] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [rows, setRows] = useState<(PaymentRow & { amount: string | null })[]>([]);
  const [deployed, setDeployed] = useState<string>("");

  const ready = !!s && !!KOZAPAY_ADDRESS;

  async function connect() {
    try {
      setBusy(true);
      setStatus("connecting");
      const session = await connectWallet((step) => setStatus(step));
      setS(session);
      setStatus("connected · Arbitrum Sepolia");
      if (KOZAPAY_ADDRESS) {
        refreshLedger(session);
        hasPendingWithdraw(session).then(setPending).catch(() => {});
      }
    } catch (e: any) {
      setStatus("connection error: " + niceError(e));
    } finally {
      setBusy(false);
    }
  }

  async function run(label: string, fn: () => Promise<any>, after?: () => void) {
    if (!s) return setStatus("connect your wallet first");
    try {
      setBusy(true);
      setStatus(label + "…");
      await fn();
      setStatus(label + " done");
      after?.();
    } catch (e: any) {
      setStatus(label + " failed: " + niceError(e));
    } finally {
      setBusy(false);
    }
  }

  async function showBalance(session = s) {
    if (!session) return setStatus("connect your wallet first");
    try {
      setStatus("decrypting your balance");
      const b = await myBalance(session);
      setBalance(formatEther(b));
      setStatus("balance decrypted");
    } catch (e: any) {
      setStatus("decrypt failed: " + niceError(e));
    }
  }

  async function refreshLedger(session = s) {
    if (!session) return;
    try {
      setStatus("loading your payments");
      const list = await myPayments(session);
      setRows(list.map((r) => ({ ...r, amount: null })));
      setStatus(list.length + (list.length === 1 ? " payment" : " payments"));
    } catch (e: any) {
      setStatus("ledger failed: " + niceError(e));
    }
  }

  async function revealRow(row: PaymentRow) {
    if (!s) return;
    try {
      const v = await paymentAmount(s, row);
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, amount: formatEther(v) } : r)));
    } catch (e: any) {
      setStatus("decrypt failed: " + niceError(e));
    }
  }

  function doSend() {
    run("Private send", async () => {
      const to = sendTo.trim();
      if (!isAddress(to)) throw new Error("Recipient is not a valid address.");
      await send(s!, to as Address, toWei(sendAmt));
      setSendAmt("");
    }, () => { refreshLedger(); setBalance(null); });
  }

  function doPayroll() {
    run("Payroll", async () => {
      const lines = payrollText.split("\n").map((l) => l.trim()).filter(Boolean);
      const to: Address[] = [];
      const amounts: bigint[] = [];
      for (const l of lines) {
        const [a, amt] = l.split(",").map((x) => (x ?? "").trim());
        if (!isAddress(a)) throw new Error(`"${a}" is not a valid address.`);
        to.push(a as Address);
        amounts.push(toWei(amt ?? ""));
      }
      await payroll(s!, to, amounts);
      setPayrollText("");
    }, () => { refreshLedger(); setBalance(null); });
  }

  function doRequestWithdraw() {
    run("Withdraw request", async () => {
      await requestWithdraw(s!, toWei(withdrawAmt));
      setWithdrawAmt("");
      setPending(true);
    }, () => setBalance(null));
  }

  function doFinalizeWithdraw() {
    run("Withdraw", async () => {
      const got = await finalizeWithdraw(s!);
      setPending(false);
      if (got === 0n) throw new Error("Your balance was too small, so 0 ETH was set aside. Nothing was sent.");
    }, () => setBalance(null));
  }

  function doDeploy() {
    run("Deploy", async () => {
      const a = await deployKozaPay(s!);
      setDeployed(a);
    });
  }

  return (
    <div className="page">
      <div className="grain" aria-hidden />
      <header className="bar">
        <div className="brand">
          <span className="mark">KOZAPAY</span>
          <span className="net">Fhenix · Arbitrum Sepolia</span>
        </div>
        {s ? (
          <span className="wallet">{short(s.account)}</span>
        ) : (
          <button className="connect" onClick={connect} disabled={busy}>Connect wallet</button>
        )}
      </header>

      <div className="ticker">
        <span className="dot" data-on={!!s} />
        {status}
      </div>

      {!KOZAPAY_ADDRESS && (
        <section className="mod deploy">
          <div className="mod-head">
            <span className="step">00</span>
            <div><h3>Deploy the contract</h3><span className="verb">one time · Arbitrum Sepolia</span></div>
          </div>
          <p className="mod-sub">
            This copy of KozaPay has no contract yet. Connect your wallet and deploy it once. Then put the
            address in <code>kozapay.ts</code> and publish the site again.
          </p>
          <button disabled={busy || !s} onClick={doDeploy}>Deploy KozaPay</button>
          {deployed && (
            <p className="deployed">
              Deployed at <code>{deployed}</code>{" "}
              <a href={`${EXPLORER}/address/${deployed}`} target="_blank" rel="noreferrer">view</a>
            </p>
          )}
        </section>
      )}

      <section className="vault">
        <div className="vault-eyebrow">encrypted balance</div>
        <Cipher value={balance} big />
        <div className="vault-unit">{balance !== null ? "ETH" : "invisible on-chain"}</div>
        <button className="reveal" onClick={() => showBalance()} disabled={!ready || busy}>
          {balance !== null ? "decrypt again" : "decrypt →"}
        </button>
        <p className="vault-note">Your balance is stored on-chain as a euint128. Only your wallet can decrypt it.</p>
      </section>

      <section className="flow">
        <article className="mod">
          <div className="mod-head">
            <span className="step">01</span>
            <div><h3>Deposit</h3><span className="verb">encrypt</span></div>
          </div>
          <p className="mod-sub">Move ETH into your private balance. The deposit amount is public; everything after it is not.</p>
          <input placeholder="0.01 ETH" inputMode="decimal" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} />
          <button
            disabled={busy || !ready}
            onClick={() => run("Deposit", async () => { await deposit(s!, toWei(depositAmt)); setDepositAmt(""); }, () => setBalance(null))}
          >
            Deposit
          </button>
        </article>

        <article className="mod">
          <div className="mod-head">
            <span className="step">02</span>
            <div><h3>Private send</h3><span className="verb">transfer · recallable</span></div>
          </div>
          <p className="mod-sub">The amount travels encrypted. You can take it back until the recipient claims it.</p>
          <input placeholder="recipient 0x…" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
          <input placeholder="amount in ETH" inputMode="decimal" value={sendAmt} onChange={(e) => setSendAmt(e.target.value)} />
          <button disabled={busy || !ready} onClick={doSend}>Send</button>
        </article>

        <article className="mod wide">
          <div className="mod-head">
            <span className="step">03</span>
            <div><h3>Private payroll</h3><span className="verb">transfer · max {MAX_PAYROLL} · each person sees only their own amount</span></div>
          </div>
          <p className="mod-sub">One line per person: address,amount in ETH</p>
          <textarea rows={4} placeholder={"0xabc…,0.01\n0xdef…,0.025"} value={payrollText} onChange={(e) => setPayrollText(e.target.value)} />
          <button disabled={busy || !ready} onClick={doPayroll}>Send payroll</button>
        </article>

        <article className="mod wide">
          <div className="mod-head">
            <span className="step">04</span>
            <div><h3>Withdraw</h3><span className="verb">decrypt · two steps</span></div>
          </div>
          {!pending ? (
            <>
              <p className="mod-sub">Step 1: set an amount aside from your private balance. If your balance is too small, 0 is set aside.</p>
              <input placeholder="amount in ETH" inputMode="decimal" value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} />
              <button disabled={busy || !ready} onClick={doRequestWithdraw}>Set aside</button>
            </>
          ) : (
            <>
              <p className="mod-sub">Step 2: the Fhenix network decrypts the amount you set aside and signs it. Submit it to receive your ETH.</p>
              <button disabled={busy || !ready} onClick={doFinalizeWithdraw}>Receive ETH</button>
            </>
          )}
        </article>
      </section>

      <section className="ledger">
        <div className="ledger-head">
          <h3>Ledger</h3>
          <button className="ghost" onClick={() => refreshLedger()} disabled={!ready || busy}>refresh</button>
        </div>
        {rows.length === 0 && <div className="empty">No payments yet. Send one, then hit “refresh”.</div>}
        {rows.map((r) => {
          const incoming = r.to.toLowerCase() === s?.account.toLowerCase();
          const settled = r.claimed || r.recalled;
          const state = r.claimed ? "claimed" : r.recalled ? "recalled" : "pending";
          return (
            <div className="entry" key={r.id.toString()}>
              <div className="entry-left">
                <span className="entry-id">#{r.id.toString()}</span>
                <span className={"arrow " + (incoming ? "in" : "out")}>{incoming ? "in" : "out"}</span>
                <span className="entry-peer">{short(incoming ? r.from : r.to)}</span>
                <span className={"pill " + (r.claimed ? "ok" : r.recalled ? "no" : "wait")}>{state}</span>
              </div>
              <div className="entry-right">
                <button className="chip" onClick={() => revealRow(r)} title="decrypt amount"><Cipher value={r.amount} /></button>
                {!settled && incoming && (
                  <button className="act" disabled={busy} onClick={() => run("Claim", () => claim(s!, r.id), () => { refreshLedger(); setBalance(null); })}>claim</button>
                )}
                {!settled && !incoming && (
                  <button className="act" disabled={busy} onClick={() => run("Recall", () => recall(s!, r.id), () => { refreshLedger(); setBalance(null); })}>recall</button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <footer>
        <span>KozaPay · private payments on FHE</span>
        {KOZAPAY_ADDRESS ? (
          <a href={`${EXPLORER}/address/${KOZAPAY_ADDRESS}`} target="_blank" rel="noreferrer">{short(KOZAPAY_ADDRESS)}</a>
        ) : (
          <span>contract not deployed</span>
        )}
      </footer>
    </div>
  );
}
