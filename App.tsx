import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import {
  initCofhe,
  deposit,
  send,
  payroll,
  claim,
  recall,
  unsealBalance,
  unsealPaymentAmount,
  KOZAPAY_ADDRESS,
  KOZAPAY_ABI,
} from "./kozapayCofhe";

const USDC_DECIMALS = 6;
const toUnits = (x: string) => ethers.parseUnits(x || "0", USDC_DECIMALS);
const fromUnits = (x: bigint) => ethers.formatUnits(x, USDC_DECIMALS);

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

type PaymentRow = {
  id: number;
  from: string;
  to: string;
  claimed: boolean;
  recalled: boolean;
  amount: string | null;
};

export default function App() {
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState("cüzdan bekleniyor");
  const [busy, setBusy] = useState(false);

  const [depositAmt, setDepositAmt] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [payrollText, setPayrollText] = useState("");
  const [balance, setBalance] = useState<string | null>(null);
  const [rows, setRows] = useState<PaymentRow[]>([]);

  async function connect() {
    try {
      const eth = (window as any).ethereum;
      if (!eth) return setStatus("MetaMask bulunamadı");
      const provider = new ethers.BrowserProvider(eth);
      await provider.send("eth_requestAccounts", []);
      const s = await provider.getSigner();
      setStatus("cofhejs başlatılıyor");
      await initCofhe(s, provider);
      setSigner(s);
      setAccount(await s.getAddress());
      setStatus("bağlı · Arbitrum Sepolia");
    } catch (e: any) {
      setStatus("bağlantı hatası — " + (e?.message ?? e));
    }
  }

  async function run(label: string, fn: () => Promise<any>, after?: () => void) {
    if (!signer) return setStatus("önce cüzdanı bağla");
    try {
      setBusy(true);
      setStatus(label + " gönderiliyor");
      const tx = await fn();
      if (tx?.wait) await tx.wait();
      setStatus(label + " tamam");
      after?.();
    } catch (e: any) {
      setStatus(label + " hatası — " + (e?.reason ?? e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function showBalance() {
    if (!signer) return setStatus("önce cüzdanı bağla");
    try {
      setStatus("bakiye çözülüyor");
      const b = await unsealBalance(signer, account);
      setBalance(fromUnits(b));
      setStatus("bakiye çözüldü");
    } catch (e: any) {
      setStatus("çözme hatası — " + (e?.message ?? e));
    }
  }

  async function loadPayments() {
    if (!signer) return;
    try {
      setStatus("defter yükleniyor");
      const c = new ethers.Contract(KOZAPAY_ADDRESS, KOZAPAY_ABI, signer);
      const count: bigint = await c.paymentsCount();
      const me = account.toLowerCase();
      const out: PaymentRow[] = [];
      for (let i = 0; i < Number(count); i++) {
        const p = await c.payments(i);
        if (p.from.toLowerCase() !== me && p.to.toLowerCase() !== me) continue;
        out.push({ id: i, from: p.from, to: p.to, claimed: p.claimed, recalled: p.recalled, amount: null });
      }
      setRows(out);
      setStatus(out.length + " kayıt");
    } catch (e: any) {
      setStatus("defter hatası — " + (e?.message ?? e));
    }
  }

  async function revealRow(id: number) {
    try {
      const v = await unsealPaymentAmount(signer!, id);
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, amount: fromUnits(v) } : r)));
    } catch (e: any) {
      setStatus("çözme hatası — " + (e?.message ?? e));
    }
  }

  function doPayroll() {
    const lines = payrollText.split("\n").map((l) => l.trim()).filter(Boolean);
    const recipients: string[] = [];
    const amounts: bigint[] = [];
    for (const l of lines) {
      const [addr, amt] = l.split(",").map((x) => x.trim());
      recipients.push(addr);
      amounts.push(toUnits(amt));
    }
    run("Bordro", () => payroll(signer!, recipients, amounts), loadPayments);
  }

  const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);

  return (
    <div className="page">
      <div className="grain" aria-hidden />
      <header className="bar">
        <div className="brand">
          <span className="mark">KOZAPAY</span>
          <span className="net">Fhenix · Arbitrum Sepolia</span>
        </div>
        {account ? (
          <span className="wallet">{short(account)}</span>
        ) : (
          <button className="connect" onClick={connect}>Cüzdanı bağla</button>
        )}
      </header>

      <div className="ticker">
        <span className="dot" data-on={!!account} />
        {status}
      </div>

      <section className="vault">
        <div className="vault-eyebrow">şifreli bakiye</div>
        <Cipher value={balance} big />
        <div className="vault-unit">{balance !== null ? "USDC" : "zincirde görünmez"}</div>
        <button className="reveal" onClick={showBalance} disabled={!account}>
          {balance !== null ? "yeniden çöz" : "çöz →"}
        </button>
        <p className="vault-note">Tutar zincirde euint128 olarak duruyor. Yalnızca senin cüzdanın çözebilir.</p>
      </section>

      <section className="flow">
        <article className="mod">
          <div className="mod-head">
            <span className="step">01</span>
            <div><h3>Yatır</h3><span className="verb">encrypt</span></div>
          </div>
          <p className="mod-sub">USDC'yi kasaya al. Bu adımda tutar public (giriş kapısı).</p>
          <input placeholder="0.00" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} />
          <button disabled={busy || !account} onClick={() => run("Yatırma", () => deposit(signer!, toUnits(depositAmt)), showBalance)}>Kasaya yatır</button>
        </article>

        <article className="mod">
          <div className="mod-head">
            <span className="step">02</span>
            <div><h3>Gizli gönder</h3><span className="verb">transfer · geri alınabilir</span></div>
          </div>
          <p className="mod-sub">Tutar şifreli gider. Alıcı çekene kadar geri alabilirsin.</p>
          <input placeholder="alıcı 0x…" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
          <input placeholder="tutar" value={sendAmt} onChange={(e) => setSendAmt(e.target.value)} />
          <button disabled={busy || !account} onClick={() => run("Gönderim", () => send(signer!, sendTo.trim(), toUnits(sendAmt)), loadPayments)}>Gönder</button>
        </article>

        <article className="mod wide">
          <div className="mod-head">
            <span className="step">03</span>
            <div><h3>Gizli bordro</h3><span className="verb">transfer · max 20 · herkes yalnız kendi tutarını görür</span></div>
          </div>
          <p className="mod-sub">Her satır: adres,tutar</p>
          <textarea rows={4} placeholder={"0xabc…,100\n0xdef…,250"} value={payrollText} onChange={(e) => setPayrollText(e.target.value)} />
          <button disabled={busy || !account} onClick={doPayroll}>Bordroyu dağıt</button>
        </article>
      </section>

      <section className="ledger">
        <div className="ledger-head">
          <h3>Defter</h3>
          <button className="ghost" onClick={loadPayments} disabled={!account}>yenile</button>
        </div>
        {rows.length === 0 && <div className="empty">Kayıt yok. Bir gönderim yap, sonra “yenile”.</div>}
        {rows.map((r) => {
          const incoming = r.to.toLowerCase() === account.toLowerCase();
          const settled = r.claimed || r.recalled;
          const state = r.claimed ? "alındı" : r.recalled ? "geri alındı" : "bekliyor";
          return (
            <div className="entry" key={r.id}>
              <div className="entry-left">
                <span className="entry-id">#{r.id}</span>
                <span className={"arrow " + (incoming ? "in" : "out")}>{incoming ? "gelen" : "giden"}</span>
                <span className="entry-peer">{short(incoming ? r.from : r.to)}</span>
                <span className={"pill " + (r.claimed ? "ok" : r.recalled ? "no" : "wait")}>{state}</span>
              </div>
              <div className="entry-right">
                <button className="chip" onClick={() => revealRow(r.id)}><Cipher value={r.amount} /></button>
                {!settled && incoming && <button className="act" onClick={() => run("Claim", () => claim(signer!, r.id), loadPayments)}>al</button>}
                {!settled && !incoming && <button className="act" onClick={() => run("Recall", () => recall(signer!, r.id), loadPayments)}>geri al</button>}
              </div>
            </div>
          );
        })}
      </section>

      <footer>
        <span>KozaPay · FHE üzerinde gizli ödeme</span>
        <a href={"https://sepolia.arbiscan.io/address/" + KOZAPAY_ADDRESS} target="_blank" rel="noreferrer">{short(KOZAPAY_ADDRESS)}</a>
      </footer>
    </div>
  );
}
