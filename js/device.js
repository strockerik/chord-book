// Device & Viewport Profile Detection (js/device.js)
// Distinguishes Phone (iPhone / Android mobile), Tablet (iPad), and Desktop browsers
// so the app adapts defaults (e.g., Mobile Scroll on iPhone vs 1-Sheet 8.5x11 on Desktop/iPad)
// while allowing an explicit user override in the Account ("You") sheet.

import { loadLocal, saveLocal } from "./core.js";

const VALID_OVERRIDES = new Set(["auto", "phone", "tablet", "desktop"]);

export function getDeviceOverride() {
  const saved = loadLocal("device_override", "auto");
  return VALID_OVERRIDES.has(saved) ? saved : "auto";
}

export function detectDeviceKind() {
  const override = getDeviceOverride();
  if (override !== "auto") return override;

  if (typeof window === "undefined") return "desktop";

  const ua = (typeof navigator !== "undefined" ? navigator.userAgent : "") || "";
  const platform = (typeof navigator !== "undefined" ? navigator.platform : "") || "";
  const maxTouch = (typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0) || 0;

  const vw = window.innerWidth || document.documentElement?.clientWidth || 1280;
  const sw = window.screen?.width || vw;
  const sh = window.screen?.height || vw;
  const minScreen = Math.min(sw, sh);
  const coarsePointer = typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;

  const isPhoneUA = /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua);
  const isIPad = /iPad/i.test(ua) || (platform === "MacIntel" && maxTouch > 1);
  const isTabletUA = isIPad || (/Android|Tablet/i.test(ua) && !/Mobile/i.test(ua));

  if (vw <= 640 || isPhoneUA || (coarsePointer && minScreen < 600)) {
    return "phone";
  }
  if (isTabletUA || (coarsePointer && vw <= 1180)) {
    return "tablet";
  }
  return "desktop";
}

export function getDeviceProfile() {
  const kind = detectDeviceKind();
  const override = getDeviceOverride();
  const coarsePointer = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;
  const isStandalone = typeof window !== "undefined" && (
    window.navigator?.standalone === true ||
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches)
  );

  const labels = {
    phone: "Phone",
    tablet: "iPad",
    desktop: "Desktop"
  };

  return {
    kind,
    isPhone: kind === "phone",
    isTablet: kind === "tablet",
    isDesktop: kind === "desktop",
    isTouch: coarsePointer || kind === "phone" || kind === "tablet",
    isStandalone,
    override,
    label: labels[kind] || labels.desktop
  };
}

export function applyDeviceBodyAttributes() {
  if (typeof document === "undefined") return getDeviceProfile();
  const profile = getDeviceProfile();
  document.body.dataset.device = profile.kind;
  document.body.dataset.standalone = profile.isStandalone ? "true" : "false";

  const badge = document.getElementById("device-mode-badge");
  if (badge) {
    badge.textContent = profile.label;
  }

  const sel = document.getElementById("device-override-select");
  if (sel) {
    sel.value = profile.override;
  }

  return profile;
}

export function setDeviceOverride(mode, onChange = null) {
  const normalized = VALID_OVERRIDES.has(mode) ? mode : "auto";
  saveLocal("device_override", normalized);
  const profile = applyDeviceBodyAttributes();
  if (typeof onChange === "function") onChange(profile);
  return profile;
}
