'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { HugeiconsIcon } from '@hugeicons/react';
import { SquareLock02Icon, ViewIcon, ViewOffIcon, Loading03Icon } from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function LoginPage(): React.JSX.Element {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        const message =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : 'That password didn\'t work, give it another try.';
        setError(message);
        return;
      }

      router.push('/prospects');
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="bg-muted/30 flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center gap-3 text-center">
          <div className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-lg">
            <HugeiconsIcon icon={SquareLock02Icon} strokeWidth={2} className="size-5" />
          </div>
          <div className="flex flex-col gap-1">
            <CardTitle className="text-lg">Biz Scraper</CardTitle>
            <CardDescription>Enter the dashboard password to continue.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-foreground text-sm font-medium">
                Password
              </label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  autoFocus
                  autoComplete="current-password"
                  aria-invalid={error ? true : undefined}
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-9 items-center justify-center"
                  tabIndex={-1}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  <HugeiconsIcon icon={showPassword ? ViewOffIcon : ViewIcon} strokeWidth={2} className="size-4" />
                </button>
              </div>
              {error ? <p className="text-destructive text-sm">{error}</p> : null}
            </div>
            <Button type="submit" disabled={isSubmitting || password.length === 0} className="w-full">
              {isSubmitting ? (
                <>
                  <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-4 animate-spin" />
                  Signing in
                </>
              ) : (
                'Sign in'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
