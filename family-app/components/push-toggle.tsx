'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  getVapidPublicKey,
  savePushSubscription,
  removePushSubscription,
  sendTestPush,
} from '@/app/actions';

type PushState = 'unsupported' | 'denied' | 'off' | 'on' | 'loading';

/**
 * Enable/disable push notifications on THIS device. On iPhone this only
 * works after the app is added to the Home Screen (iOS requirement).
 */
export function PushToggle() {
  const [state, setState] = useState<PushState>('loading');
  const [pending, startTransition] = useTransition();
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setState('unsupported');
        return;
      }
      if (Notification.permission === 'denied') {
        setState('denied');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? 'on' : 'off');
    })().catch(() => setState('unsupported'));
  }, []);

  function enable() {
    startTransition(async () => {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setState(permission === 'denied' ? 'denied' : 'off');
          return;
        }
        const publicKey = await getVapidPublicKey();
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        const json = sub.toJSON();
        await savePushSubscription({
          endpoint: sub.endpoint,
          keys: { p256dh: json.keys!['p256dh']!, auth: json.keys!['auth']! },
        });
        setState('on');
      } catch (err) {
        console.error('push subscribe failed', err);
        alert('Could not enable notifications on this device.');
      }
    });
  }

  function disable() {
    startTransition(async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await removePushSubscription(sub.endpoint);
        await sub.unsubscribe();
      }
      setState('off');
    });
  }

  function test() {
    startTransition(async () => {
      const sent = await sendTestPush();
      setTestResult(sent > 0 ? `Sent to ${sent} device${sent === 1 ? '' : 's'} — check for the notification.` : 'No subscribed devices found.');
    });
  }

  if (state === 'loading') return null;
  if (state === 'unsupported') {
    return (
      <p className="text-sm opacity-70">
        Notifications aren&apos;t available in this browser. On iPhone: add the app to your
        Home Screen first, then enable them from inside the installed app.
      </p>
    );
  }
  if (state === 'denied') {
    return (
      <p className="text-sm opacity-70">
        Notifications are blocked for this app in your device settings — re-enable them there, then come back.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        {state === 'off' ? (
          <button
            onClick={enable}
            disabled={pending}
            className="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {pending ? '…' : 'Enable on this device'}
          </button>
        ) : (
          <>
            <button
              onClick={test}
              disabled={pending}
              className="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Send test notification
            </button>
            <button
              onClick={disable}
              disabled={pending}
              className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Turn off
            </button>
          </>
        )}
      </div>
      {state === 'on' && <p className="text-xs text-green-600 dark:text-green-400">✓ Notifications are on for this device.</p>}
      {testResult && <p className="text-xs opacity-70">{testResult}</p>}
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
