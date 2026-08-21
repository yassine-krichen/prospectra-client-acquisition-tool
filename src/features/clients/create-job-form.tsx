'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createJobRequestSchema, retainerDiscountSchema } from '@/features/clients/client.types';
import { companySizeSchema } from '@/features/prospects/prospect.types';
import { serviceTypeSchema, type ServiceType } from '@/features/pricing/service-type';
import { toastError, toastSuccess } from '@/lib/toast';

// Local mirror of `app/api/pricing/catalog/route.ts`'s response shape.
// Deliberately not imported from `service-catalog.ts` - this is a
// `'use client'` file, see CLAUDE.md's "recurring bug class" note on why
// client components must never risk pulling in a server-only import chain.
const priceRangeSchema = z.object({ minCents: z.number().int(), maxCents: z.number().int() });
const catalogEntrySchema = z.union([priceRangeSchema, z.literal('manual_quote')]);
const catalogResponseSchema = z.object({
  services: z.array(
    z.object({
      service: serviceTypeSchema,
      cadence: z.enum(['one_off', 'recurring']),
      catalogEntry: catalogEntrySchema,
    })
  ),
  infraHostingRetainerRange: priceRangeSchema,
});
type CatalogResponse = z.infer<typeof catalogResponseSchema>;

const createJobResponseSchema = z.object({
  outcome: z.enum(['created']),
  jobId: z.string(),
});

interface CreateJobFormProps {
  clientId: string;
  companySize: z.infer<typeof companySizeSchema>;
  onCreated: () => void;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function cadenceForService(catalog: CatalogResponse, service: ServiceType): 'one_off' | 'recurring' {
  if (service === 'infra_hosting_retainer') return 'recurring';
  return catalog.services.find((item) => item.service === service)?.cadence ?? 'one_off';
}

function catalogHelpText(catalog: CatalogResponse, service: ServiceType): string | null {
  if (service === 'infra_hosting_retainer') {
    const range = catalog.infraHostingRetainerRange;
    return `Suggested range: ${formatCents(range.minCents)}–${formatCents(range.maxCents)}/mo`;
  }

  const entry = catalog.services.find((item) => item.service === service);
  if (!entry) return null;
  if (entry.catalogEntry === 'manual_quote') return 'Manual quote - no suggested range for this company size.';
  return `Suggested range: ${formatCents(entry.catalogEntry.minCents)}–${formatCents(entry.catalogEntry.maxCents)}`;
}

async function fetchCatalog(companySize: string): Promise<CatalogResponse> {
  const response = await fetch(`/api/pricing/catalog?companySize=${encodeURIComponent(companySize)}`);
  if (!response.ok) {
    throw new Error(`Failed to load pricing catalog (status ${response.status}).`);
  }

  const body: unknown = await response.json();
  return catalogResponseSchema.parse(body);
}

export function CreateJobForm({ clientId, companySize, onCreated }: CreateJobFormProps): React.JSX.Element {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [service, setService] = useState<ServiceType>('landing_page');
  const [priceDollars, setPriceDollars] = useState('');
  const [retainerDiscount, setRetainerDiscount] = useState<z.infer<typeof retainerDiscountSchema> | ''>('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCatalog(companySize)
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch(() => {
        if (!cancelled) setCatalog(null);
      });
    return () => {
      cancelled = true;
    };
  }, [companySize]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();

    const priceCents = Math.round(Number(priceDollars) * 100);
    const parsed = createJobRequestSchema.safeParse({
      service,
      agreedPriceCents: priceCents,
      retainerDiscount: service === 'infra_hosting_retainer' && retainerDiscount ? retainerDiscount : undefined,
      notes: notes.trim() === '' ? undefined : notes,
    });

    if (!parsed.success) {
      toastError('Invalid input', parsed.error.issues.map((issue) => issue.message).join('; '));
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/clients/${clientId}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });

      if (response.status === 404) {
        toastError('Client not found', "This client may have been deleted - reload the page.");
        return;
      }

      if (response.status === 400) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : 'The server rejected this input.';
        toastError('Invalid input', message);
        return;
      }

      if (!response.ok) {
        toastError('Request failed', `Server responded with status ${response.status}.`);
        return;
      }

      const body: unknown = await response.json();
      createJobResponseSchema.parse(body);
      toastSuccess('Job created', `${service.replace(/_/g, ' ')} for ${formatCents(priceCents)}.`);
      setPriceDollars('');
      setNotes('');
      setRetainerDiscount('');
      onCreated();
    } catch (err) {
      toastError('Request failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const priceCentsPreview = Math.round(Number(priceDollars) * 100);
  const hasValidPrice = priceDollars.trim() !== '' && Number.isFinite(priceCentsPreview) && priceCentsPreview > 0;
  const cadence = catalog ? cadenceForService(catalog, service) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Job</CardTitle>
        <CardDescription>Record a sold service against this client. Cadence follows the service - it&apos;s never a free choice.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-muted-foreground text-xs font-medium">Service</label>
              <Select value={service} onValueChange={(value) => setService(value as ServiceType)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {serviceTypeSchema.options.map((option) => (
                    <SelectItem key={option} value={option} className="capitalize">
                      {option.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-muted-foreground text-xs font-medium">Agreed price (USD)</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={priceDollars}
                onChange={(event) => setPriceDollars(event.target.value)}
                required
              />
            </div>
          </div>

          {catalog ? (
            <div className="bg-muted flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm">
              <span className="text-foreground">{catalogHelpText(catalog, service)}</span>
              <span className="text-muted-foreground text-xs capitalize">
                Cadence: {cadence === 'recurring' ? 'Monthly (recurring)' : 'One-off'} - derived from the service, not chosen here.
              </span>
            </div>
          ) : null}

          {service === 'infra_hosting_retainer' ? (
            <div className="flex flex-col gap-1.5 sm:w-1/2">
              <label className="text-muted-foreground text-xs font-medium">Retainer discount</label>
              <Select
                value={retainerDiscount === '' ? 'none' : retainerDiscount}
                onValueChange={(value) =>
                  setRetainerDiscount(value === 'none' ? '' : (value as z.infer<typeof retainerDiscountSchema>))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {retainerDiscountSchema.options.map((option) => (
                    <SelectItem key={option} value={option} className="capitalize">
                      {option.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <label className="text-muted-foreground text-xs font-medium">Notes</label>
            <textarea
              className="border-input bg-background w-full rounded-md border p-2 text-sm"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

          {hasValidPrice ? (
            <p className="text-muted-foreground text-xs">
              About to record: <span className="text-foreground font-medium capitalize">{service.replace(/_/g, ' ')}</span>{' '}
              ({cadence === 'recurring' ? 'monthly' : 'one-off'}) at{' '}
              <span className="text-foreground font-medium">{formatCents(priceCentsPreview)}</span>
              {cadence === 'recurring' ? '/mo' : ''}.
            </p>
          ) : null}

          <Button type="submit" disabled={isSubmitting} className="w-fit">
            {isSubmitting ? 'Creating…' : 'Create Job'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
