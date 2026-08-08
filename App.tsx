import { useState } from "react";
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

type PaymentRow = {
  id: number;
  from: string;
  to: string;
  claimed: boolean;
  recalled: boolean;
  amount?: string;
};

export default function App() {
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [account, setAccount] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const [depositAmt, setDepositAmt] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [payrollText, setPayrollText] = useState("");
  const [balance, setBalance] = useState<string>("");
  const [rows, setRows] = useState<PaymentRow[]>([]);

  async function connect() {
    try {
      if (!(window as any).ethereum) return setStatus("MetaMask bulunamadi");
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      await provider.send("eth_requestAccounts", []);
      const s = await provider.getSigner();
      const addr = await s.getAddress();
      setStatus("cofhejs baslatiliyor...");
      await initCofhe(s, provider);
      setSigner(s);
      setAccount(addr);
      setStatus("Bagli");
    } catch (e: any) {
      setStatus("Baglanti hatasi: " + (e?.message ?? e));
    }
  }

  async function run(label: string, fn: () => Promise<any>) {
    if (!signer) return setStatus("Once cuzdani bagla");
    try {
      setBusy(true);
      setStatus(label + "...");
      const tx = await fn();
      if (tx?.wait) await tx.wait();
      setStatus(label + " tamam");
    } catch (e: any) {
      setStatus(label + " hata: " + (e?.reason ?? e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function doDeposit() {
    await run("Deposit", () => deposit(signer!, toUnits(depositAmt)));
  }

  async function doSend() {
    await run("Gonderim", () => send(signer!, sendTo.trim(), toUnits(sendAmt)));
  }

  async function doPayroll() {
    const lines = payrollText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const recipients: string[] = [];
    const amounts: bigint[] = [];
    for (const l of lines) {
      const [addr, amt] = l.split(",").map((x) => x.trim());
      recipients.push(addr);
      amounts.push(toUnits(amt));
    }
    await run("Bordro", () => payroll(signer!, recipients, amounts));
  }

  async function showBalance() {
    if (!signer) return setStatus("Once cuzdani bagla");
    try {
      setStatus("Bakiye cozuluyor...");
      const b = await unsealBalance(signer, account);
      setBalance(fromUnits(b));
      setStatus("Bakiye cozuldu");
    } catch (e: any) {
      setStatus("Bakiye hata: " + (e?.message ?? e));
    }
  }

  async function loadPayments() {
    if (!signer) return setStatus("Once cuzdani bagla");
    try {
      setStatus("Odemeler yukleniyor...");
      const c = new ethers.Contract(KOZAPAY_ADDRESS, KOZAPAY_ABI, signer);
      const count: bigint = await c.paymentsCount();
      const out: PaymentRow[] = [];
      const me = account.toLowerCase();
      for (let i = 0; i < Number(count); i++) {
        const p = await c.payments(i);
        const from = p.from.toLowerCase();
        const to = p.to.toLowerCase();
        if (from !== me && to !== me) continue; // sadece beni ilgilendirenler
        out.push({ id: i, from: p.from, to: p.to, claimed: p.claimed, recalled: p.recalled });
      }
      setRows(out);
      setStatus(out.length + " odeme bulundu");
    } catch (e: any) {
      setStatus("Odeme hata: " + (e?.message ?? e));
    }
  }

  async function unsealRow(id: number) {
    try {
      const v = await unsealPaymentAmount(signer!, id);
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, amount: fromUnits(v) } : r)));
    } catch (e: any) {
      setStatus("Coz hata: " + (e?.message ?? e));
    }
  }

  return (
    <div className="wrap">
      <header>
        <h1>KozaPay <span className="tag">Fhenix</span></h1>
        <p className="sub">Gizli USDC odemeleri · geri cagrilabilir transfer + gizli bordro · Arbitrum Sepolia</p>
        {account ? (
          <div className="acct">{account.slice(0, 6)}...{account.slice(-4)}</div>
        ) : (
          <button className="primary" onClick={connect}>Cuzdani Bagla</button>
        )}
      </header>

      {status && <div className="status">{status}</div>}

      <section className="grid">
        <div className="card">
          <h2>Deposit</h2>
          <p className="hint">USDC yatir (public on-ramp)</p>
          <input placeholder="tutar (USDC)" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} />
          <button disabled={busy} onClick={doDeposit}>Yatir</button>
        </div>

        <div className="card">
          <h2>Gizli Gonderim</h2>
          <p className="hint">geri cagrilabilir · tutar sifreli</p>
          <input placeholder="alici adresi (0x...)" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
          <input placeholder="tutar (USDC)" value={sendAmt} onChange={(e) => setSendAmt(e.target.value)} />
          <button disabled={busy} onClick={doSend}>Gonder</button>
        </div>

        <div className="card">
          <h2>Gizli Bordro</h2>
          <p className="hint">her satir: adres,tutar (max 20)</p>
          <textarea
            rows={5}
            placeholder={"0xabc...,100\n0xdef...,250"}
            value={payrollText}
            onChange={(e) => setPayrollText(e.target.value)}
          />
          <button disabled={busy} onClick={doPayroll}>Bordroyu Gonder</button>
        </div>

        <div className="card">
          <h2>Bakiyem</h2>
          <p className="hint">sifreli bakiyeyi coz (sadece sen gorursun)</p>
          <div className="bal">{balance ? balance + " USDC" : "—"}</div>
          <button onClick={showBalance}>Bakiyeyi Coz</button>
        </div>
      </section>

      <section className="card full">
        <div className="row-head">
          <h2>Odemelerim</h2>
          <button onClick={loadPayments}>Yenile</button>
        </div>
        {rows.length === 0 && <p className="hint">Henuz odeme yok. "Yenile"ye bas.</p>}
        {rows.map((r) => {
          const incoming = r.to.toLowerCase() === account.toLowerCase();
          const settled = r.claimed || r.recalled;
          return (
            <div className="pay" key={r.id}>
              <div>
                <b>#{r.id}</b> {incoming ? "gelen ←" : "giden →"}{" "}
                {incoming ? r.from.slice(0, 8) : r.to.slice(0, 8)}...
                <span className={"badge " + (r.claimed ? "ok" : r.recalled ? "no" : "wait")}>
                  {r.claimed ? "alindi" : r.recalled ? "geri alindi" : "bekliyor"}
                </span>
              </div>
              <div className="actions">
                <button onClick={() => unsealRow(r.id)}>Tutari Coz {r.amount ? "(" + r.amount + ")" : ""}</button>
                {!settled && incoming && <button onClick={() => run("Claim", () => claim(signer!, r.id)).then(loadPayments)}>Al</button>}
                {!settled && !incoming && <button onClick={() => run("Recall", () => recall(signer!, r.id)).then(loadPayments)}>Geri Al</button>}
              </div>
            </div>
          );
        })}
      </section>

      <footer>KozaPay · Fhenix CoFHE · {KOZAPAY_ADDRESS.slice(0, 10)}...</footer>
    </div>
  );
}
