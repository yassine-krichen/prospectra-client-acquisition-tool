import { describe, expect, it, vi } from 'vitest';

const executablePathMock = vi.fn();
vi.mock('@sparticuz/chromium', () => ({
  default: {
    args: ['--sparticuz-flag-one', '--sparticuz-flag-two'],
    executablePath: executablePathMock,
  },
}));

const { resolveLaunchOptions } = await import('./browser');

describe('resolveLaunchOptions', () => {
  it('returns plain local launch options (no executablePath) when not serverless', async () => {
    const options = await resolveLaunchOptions(false);

    expect(options).toEqual({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
    expect(executablePathMock).not.toHaveBeenCalled();
  });

  it('resolves @sparticuz/chromium and merges its args when serverless', async () => {
    executablePathMock.mockResolvedValue('/opt/chromium/chromium');

    const options = await resolveLaunchOptions(true);

    expect(options).toEqual({
      headless: true,
      executablePath: '/opt/chromium/chromium',
      args: ['--sparticuz-flag-one', '--sparticuz-flag-two', '--disable-blink-features=AutomationControlled'],
    });
  });
});
