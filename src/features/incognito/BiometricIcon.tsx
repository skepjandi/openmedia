import { useEffect, useState } from "react";
import { FaceIdIcon, FingerprintIcon } from "../../shared/icons";
import { incognito, type BiometryKind } from "./ipc";

let known: BiometryKind | null = null;
let pending: Promise<BiometryKind> | null = null;

/** Asks Rust once; the device's biometric cannot change while the app runs. A failure is a fingerprint. */
function loadBiometryKind(): Promise<BiometryKind> {
  pending ??= incognito
    .biometryKind()
    .catch((): BiometryKind => "fingerprint")
    .then((kind) => (known = kind));
  return pending;
}

/** Face ID on a device that has it, a fingerprint otherwise (and until Rust answers). */
export function BiometricIcon({ size }: { size?: number }) {
  const [kind, setKind] = useState<BiometryKind>(known ?? "fingerprint");
  useEffect(() => {
    if (known) return;
    let current = true;
    void loadBiometryKind().then((loaded) => current && setKind(loaded));
    return () => {
      current = false;
    };
  }, []);
  return kind === "face" ? <FaceIdIcon size={size} /> : <FingerprintIcon size={size} />;
}
