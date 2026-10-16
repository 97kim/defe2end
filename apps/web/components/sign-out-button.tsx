"use client";

import { useRouter } from "next/navigation";
import { authClient } from "../lib/auth-client";
import { guardNavigation } from "../lib/navigation-guard";

export function SignOutButton({ label }: { label: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="w-full rounded-control px-3 py-2 text-left text-body text-text-secondary hover:bg-accent-soft hover:text-text-primary"
      onClick={() =>
        void guardNavigation(async () => {
          await authClient.signOut();
          router.replace("/login");
          router.refresh();
        })
      }
    >
      {label}
    </button>
  );
}
