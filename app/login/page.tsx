'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  SquareLock02Icon,
  ViewIcon,
  ViewOffIcon,
  Loading03Icon,
  UserCircleIcon,
  UnfoldMoreIcon,
  Alert02Icon,
} from '@hugeicons/core-free-icons';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { KNOWN_USERNAMES, type KnownUsername } from '@/features/auth/known-usernames';

export default function LoginPage(): React.JSX.Element {
  const router = useRouter();

  const [comboboxOpen, setComboboxOpen] = useState(false);
  const [selectedUsername, setSelectedUsername] = useState<KnownUsername | null>(null);
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSelectUsername(username: KnownUsername): Promise<void> {
    setSelectedUsername(username);
    setComboboxOpen(false);
    setPassword('');
    setConfirmPassword('');
    setError(null);
    setNeedsSetup(null);
    setIsCheckingStatus(true);

    try {
      const response = await fetch(`/api/login/status?nickname=${encodeURIComponent(username)}`);
      const data: unknown = await response.json().catch(() => null);
      const parsedNeedsSetup =
        data && typeof data === 'object' && 'needsSetup' in data ? Boolean(data.needsSetup) : true;
      setNeedsSetup(response.ok ? parsedNeedsSetup : true);
    } catch {
      // Network hiccup - default to the "set a password" prompt rather than
      // silently blocking the form. If a password already exists, the login
      // route itself will reject an 8+ char guess with "Incorrect password."
      // instead of accidentally minting a new one.
      setNeedsSetup(true);
    } finally {
      setIsCheckingStatus(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedUsername) return;
    setError(null);

    if (needsSetup && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: selectedUsername, password }),
      });

      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        const message =
          data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
            ? data.error
            : 'That didn\'t work, give it another try.';
        setError(message);
        return;
      }

      router.push('/prospects');
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  }

  const canSubmit =
    selectedUsername !== null &&
    needsSetup !== null &&
    !isCheckingStatus &&
    (needsSetup ? password.length >= 8 && confirmPassword.length >= 8 : password.length > 0);

  return (
    <main className="bg-muted/30 flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center gap-3 text-center">
          <div className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-lg">
            <HugeiconsIcon icon={SquareLock02Icon} strokeWidth={2} className="size-5" />
          </div>
          <div className="flex flex-col gap-1">
            <CardTitle className="text-lg">Biz Scraper</CardTitle>
            <CardDescription>Choose your account to continue.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-foreground text-sm font-medium">Account</label>
              <Popover open={comboboxOpen} onOpenChange={setComboboxOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={comboboxOpen}
                    className="w-full justify-between font-normal"
                  >
                    <span className="flex items-center gap-2">
                      <HugeiconsIcon icon={UserCircleIcon} strokeWidth={2} className="text-muted-foreground size-4" />
                      {selectedUsername ?? 'Select your account'}
                    </span>
                    <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} className="text-muted-foreground size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Find your account..." />
                    <CommandList>
                      <CommandEmpty>No account found.</CommandEmpty>
                      <CommandGroup>
                        {KNOWN_USERNAMES.map((username) => (
                          <CommandItem
                            key={username}
                            value={username}
                            data-checked={selectedUsername === username}
                            onSelect={() => void handleSelectUsername(username)}
                          >
                            <HugeiconsIcon icon={UserCircleIcon} strokeWidth={2} className="text-muted-foreground size-4" />
                            {username}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            {selectedUsername ? (
              <div className="animate-in fade-in slide-in-from-top-2 flex flex-col gap-4 duration-200">
                {isCheckingStatus ? (
                  <div className="text-muted-foreground flex items-center gap-2 text-sm">
                    <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-4 animate-spin" />
                    Checking account…
                  </div>
                ) : (
                  <>
                    <p className="text-muted-foreground text-sm">
                      {needsSetup
                        ? `This is your first time signing in as ${selectedUsername}. Create a password (min 8 characters).`
                        : `Welcome back, ${selectedUsername}. Enter your password.`}
                    </p>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="password" className="text-foreground text-sm font-medium">
                        {needsSetup ? 'New password' : 'Password'}
                      </label>
                      <div className="relative">
                        <Input
                          id="password"
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          onChange={(event) => setPassword(event.target.value)}
                          placeholder={needsSetup ? 'At least 8 characters' : 'Enter your password'}
                          autoFocus
                          autoComplete={needsSetup ? 'new-password' : 'current-password'}
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
                          <HugeiconsIcon
                            icon={showPassword ? ViewOffIcon : ViewIcon}
                            strokeWidth={2}
                            className="size-4"
                          />
                        </button>
                      </div>
                    </div>

                    {needsSetup ? (
                      <div className="animate-in fade-in flex flex-col gap-1.5 duration-200">
                        <label htmlFor="confirmPassword" className="text-foreground text-sm font-medium">
                          Confirm password
                        </label>
                        <Input
                          id="confirmPassword"
                          type={showPassword ? 'text' : 'password'}
                          value={confirmPassword}
                          onChange={(event) => setConfirmPassword(event.target.value)}
                          placeholder="Re-enter your new password"
                          autoComplete="new-password"
                          aria-invalid={error ? true : undefined}
                        />
                      </div>
                    ) : null}

                    {error ? (
                      <p className="text-destructive flex items-center gap-1.5 text-sm">
                        <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4 shrink-0" />
                        {error}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            <Button type="submit" disabled={!canSubmit || isSubmitting} className="w-full">
              {isSubmitting ? (
                <>
                  <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-4 animate-spin" />
                  Signing in
                </>
              ) : needsSetup ? (
                'Create password & sign in'
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
