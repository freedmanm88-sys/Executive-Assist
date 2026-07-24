import { NextResponse, type NextRequest } from 'next/server';
import { verifySessionValue, SESSION_COOKIE } from './lib/session';

const PUBLIC_PATHS = ['/login', '/manifest.webmanifest', '/sw.js'];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/icon') ||
    pathname.startsWith('/apple-icon') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }
  const session = await verifySessionValue(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
