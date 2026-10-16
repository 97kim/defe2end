import { LinkPageFrame } from "../../components/accounts/link-page";
import { ResetForm } from "./reset-form";

export const dynamic = "force-dynamic";

/** Public: opened from a reset link `/reset#token=…` (Referrer-Policy: no-referrer via next.config). */
export default function ResetPage() {
  return (
    <LinkPageFrame>
      <ResetForm />
    </LinkPageFrame>
  );
}
