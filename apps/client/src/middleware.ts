import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublicPath = path === "/login";
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
  });

  // Redirect logic for authenticated users trying to access login/register
  if (isPublicPath && token) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Redirect logic for unauthenticated users trying to access protected routes
  if (!isPublicPath && !token && !path.startsWith("/api/auth")) {
    // For API routes
    if (path.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    // For page routes
    return NextResponse.redirect(
      new URL(`/login?callbackUrl=${encodeURIComponent(path)}`, request.url)
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Protected routes
    "/",
    "/dashboard/:path*",
    "/lp/:path*",
    // API routes
    "/api/:path*",
    // Auth pages
    "/login",
  ],
};
