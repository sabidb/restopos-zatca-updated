// ═══════════════════════════════════════════════════════════════════
// PLAN CELEBRATION + UPGRADE WALL
// - PlanUpgradeCelebration: full-screen animated "Congratulations" screen
//   shown the instant an admin upgrades a client's plan, listing every new
//   benefit they just unlocked.
// - UpgradeWall: the locked-feature placeholder shown when a client opens a
//   screen their current plan doesn't include.
// Self-contained (no design-system imports) so it can drop in anywhere.
// ═══════════════════════════════════════════════════════════════════
import { useEffect } from "react";

// Keyframes are injected once, guarded by id so re-renders don't duplicate.
const ANIM_CSS = `
@keyframes rp-pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.04)}100%{transform:scale(1);opacity:1}}
@keyframes rp-trophy{0%{transform:translateY(-14px) scale(.4);opacity:0}55%{transform:translateY(4px) scale(1.15)}100%{transform:translateY(0) scale(1);opacity:1}}
@keyframes rp-row{0%{transform:translateY(10px);opacity:0}100%{transform:translateY(0);opacity:1}}
@keyframes rp-confetti{0%{transform:translateY(-10vh) rotate(0);opacity:1}100%{transform:translateY(110vh) rotate(720deg);opacity:0}}
@keyframes rp-glow{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}50%{box-shadow:0 0 40px 4px var(--rp-glow)}}
@keyframes rp-fadein{from{opacity:0}to{opacity:1}}
`;
function useAnimStyles() {
  useEffect(() => {
    if (document.getElementById("rp-plan-anim")) return;
    const el = document.createElement("style");
    el.id = "rp-plan-anim";
    el.textContent = ANIM_CSS;
    document.head.appendChild(el);
  }, []);
}

const CONFETTI = ["#F0A500", "#1A8A4A", "#6366f1", "#ff5d8f", "#7FFAB5", "#ffd166"];

export function PlanUpgradeCelebration({ fromPlan, toPlan, benefits = [], onClose, gift = false, trialDays = 14 }) {
  useAnimStyles();
  const color = toPlan?.color || "#F0A500";
  const pieces = Array.from({ length: 26 });
  return (
    <div
      role="dialog"
      aria-label="Plan upgraded"
      style={{
        position: "fixed", inset: 0, zIndex: 100000,
        background: "rgba(6,14,10,0.82)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16, animation: "rp-fadein .25s ease",
      }}
    >
      {/* confetti */}
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
        {pieces.map((_, i) => (
          <span key={i} style={{
            position: "absolute", top: "-6vh", left: `${(i * 3.9) % 100}%`,
            width: 9, height: 9, borderRadius: i % 3 === 0 ? "50%" : 2,
            background: CONFETTI[i % CONFETTI.length],
            animation: `rp-confetti ${2.4 + (i % 5) * 0.5}s linear ${(i % 7) * 0.18}s infinite`,
          }} />
        ))}
      </div>

      <div style={{
        position: "relative", width: "min(460px,100%)", maxHeight: "90vh", overflowY: "auto",
        background: "linear-gradient(180deg,#12241b,#0d1a13)",
        border: `1px solid ${color}66`, borderRadius: 22, padding: "30px 26px 24px",
        textAlign: "center", animation: "rp-pop .5s cubic-bezier(.2,.8,.2,1) both",
        "--rp-glow": `${color}55`,
      }}>
        <div style={{
          fontSize: 58, lineHeight: 1, marginBottom: 6,
          animation: "rp-trophy .7s cubic-bezier(.2,.8,.2,1) .12s both",
        }}>{gift ? "🎁" : "🎉"}</div>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color }}>
          {gift ? "A gift for you" : "Congratulations!"}
        </div>
        <div style={{ fontSize: 23, fontWeight: 900, color: "#fff", margin: "6px 0 4px" }}>
          {gift
            ? <>{toPlan?.name || "Premium"} unlocked — free for {trialDays} days</>
            : <>You're now on {toPlan?.name || "a new"} plan</>}
        </div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", marginBottom: 18 }}>
          {gift
            ? <>Thanks for being with us. Every {toPlan?.name || "Premium"} feature is on — explore it all, no charge, no commitment.</>
            : <>{fromPlan?.name ? <>Upgraded from {fromPlan.name}. </> : null}Everything below is live on your account right now.</>}
        </div>

        {benefits.length > 0 && (
          <div style={{ textAlign: "start", marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.4)", marginBottom: 10 }}>
              ✨ {gift ? "Everything you can try now" : "New benefits you've unlocked"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {benefits.map((b, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: 10,
                  background: "rgba(255,255,255,0.04)", border: `1px solid ${color}33`,
                  borderRadius: 11, padding: "10px 13px",
                  animation: `rp-row .45s ease ${0.25 + i * 0.08}s both`,
                }}>
                  <span style={{ color, fontWeight: 900, flexShrink: 0 }}>✓</span>
                  <span style={{ fontSize: 13.5, color: "#eafff2", lineHeight: 1.35 }}>{b}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <button onClick={onClose} style={{
          width: "100%", padding: "13px 18px", border: "none", borderRadius: 12,
          background: `linear-gradient(135deg,${color},${color}cc)`, color: "#fff",
          fontSize: 15, fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
          animation: "rp-glow 2.4s ease-in-out infinite", "--rp-glow": `${color}55`,
        }}>
          {gift ? "Start exploring 🚀" : "Let's go 🚀"}
        </button>
      </div>
    </div>
  );
}

// Persistent, gently-escalating countdown while a Premium trial is live.
// Endowment + scarcity: they already HAVE it, and the clock is ticking.
export function TrialCountdownBanner({ planName = "Premium", daysLeft = 14, price, onKeep, onDismiss }) {
  useAnimStyles();
  const urgent = daysLeft <= 3;
  const color = urgent ? "#ff5d5d" : "#F0A500";
  return (
    <div style={{
      position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 18, zIndex: 99998,
      width: "min(560px,calc(100% - 24px))",
      display: "flex", alignItems: "center", gap: 12,
      background: "linear-gradient(180deg,#17271d,#0f1b14)",
      border: `1px solid ${color}66`, borderRadius: 14, padding: "11px 14px",
      boxShadow: "0 10px 34px rgba(0,0,0,0.4)", animation: "rp-pop .35s ease both",
      "--rp-glow": `${color}55`,
    }}>
      <span style={{ fontSize: 22, animation: urgent ? "rp-glow 1.6s ease-in-out infinite" : "none" }}>🎁</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>
          {planName} trial · <span style={{ color }}>{daysLeft} day{daysLeft === 1 ? "" : "s"} left</span>
        </div>
        <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)" }}>
          {urgent ? "Don't lose your new tools — " : "Enjoying the upgrade? "}
          Keep {planName}{price ? ` for SAR ${price}/mo` : ""}.
        </div>
      </div>
      <button onClick={onKeep} style={{
        flexShrink: 0, padding: "9px 16px", border: "none", borderRadius: 10,
        background: `linear-gradient(135deg,${color},${color}cc)`, color: "#fff",
        fontSize: 13, fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
      }}>Keep {planName}</button>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" style={{
          flexShrink: 0, background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 8,
          color: "rgba(255,255,255,0.5)", fontSize: 15, cursor: "pointer", padding: "3px 9px",
        }}>×</button>
      )}
    </div>
  );
}

// Soft landing when a trial lapses: nothing is deleted, here's what you'd keep.
// Loss is framed as reversible — one tap to get it all back.
export function TrialEndPrompt({ planName = "Premium", benefits = [], price, planColor = "#1A8A4A", onKeep, onClose }) {
  useAnimStyles();
  return (
    <div role="dialog" aria-label="Trial ended" style={{
      position: "fixed", inset: 0, zIndex: 100000, background: "rgba(6,14,10,0.82)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16, animation: "rp-fadein .25s ease",
    }}>
      <div style={{
        width: "min(440px,100%)", maxHeight: "90vh", overflowY: "auto",
        background: "linear-gradient(180deg,#12241b,#0d1a13)", border: `1px solid ${planColor}55`,
        borderRadius: 20, padding: "28px 24px", textAlign: "center", animation: "rp-pop .45s ease both",
      }}>
        <div style={{ fontSize: 46, marginBottom: 8 }}>⏳</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#fff", marginBottom: 6 }}>
          Your {planName} trial has ended
        </div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", lineHeight: 1.5, marginBottom: 18 }}>
          Nothing was deleted — all your data is safe. Keep {planName} to hold on to everything you set up:
        </div>
        {benefits.length > 0 && (
          <div style={{ textAlign: "start", marginBottom: 20, display: "flex", flexDirection: "column", gap: 8 }}>
            {benefits.map((b, i) => (
              <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start", background: "rgba(255,255,255,0.04)", border: `1px solid ${planColor}33`, borderRadius: 10, padding: "9px 12px" }}>
                <span style={{ color: planColor, fontWeight: 900 }}>✓</span>
                <span style={{ fontSize: 13, color: "#eafff2" }}>{b}</span>
              </div>
            ))}
          </div>
        )}
        <button onClick={onKeep} style={{
          width: "100%", padding: "13px", border: "none", borderRadius: 12,
          background: `linear-gradient(135deg,${planColor},${planColor}cc)`, color: "#fff",
          fontSize: 15, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", marginBottom: 9,
        }}>Keep {planName}{price ? ` — SAR ${price}/mo` : ""}</button>
        <button onClick={onClose} style={{
          width: "100%", padding: "10px", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 12,
          background: "transparent", color: "rgba(255,255,255,0.6)", fontSize: 13, fontWeight: 600,
          cursor: "pointer", fontFamily: "inherit",
        }}>Maybe later</button>
      </div>
    </div>
  );
}

export function UpgradeWall({ feature, requiredPlanName = "Professional", planColor = "#F0A500", note, onUpgrade }) {
  useAnimStyles();
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "40px 16px" }}>
      <div style={{
        width: "min(420px,100%)", textAlign: "center",
        background: "rgba(255,255,255,0.03)", border: `1px solid ${planColor}44`,
        borderRadius: 18, padding: "34px 26px", animation: "rp-pop .4s ease both",
      }}>
        <div style={{ fontSize: 46, marginBottom: 10 }}>🔒</div>
        <div style={{ fontSize: 18, fontWeight: 900, color: "#fff", marginBottom: 6 }}>
          {feature || "This feature"} is a {requiredPlanName} feature
        </div>
        <div style={{ fontSize: 13.5, color: "rgba(255,255,255,0.55)", lineHeight: 1.5, marginBottom: 20 }}>
          {note || `Upgrade to ${requiredPlanName} to unlock ${feature || "this feature"} for your business.`}
        </div>
        {onUpgrade && (
          <button onClick={onUpgrade} style={{
            padding: "11px 22px", border: "none", borderRadius: 11,
            background: `linear-gradient(135deg,${planColor},${planColor}cc)`, color: "#fff",
            fontSize: 14, fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
          }}>
            ⬆️ Upgrade to {requiredPlanName}
          </button>
        )}
      </div>
    </div>
  );
}
