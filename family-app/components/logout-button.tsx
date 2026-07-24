'use client';

import { logout } from '@/app/login/actions';

export function LogoutButton() {
  return (
    <button
      onClick={() => logout()}
      className="self-start rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-sm font-medium"
    >
      Sign out
    </button>
  );
}
