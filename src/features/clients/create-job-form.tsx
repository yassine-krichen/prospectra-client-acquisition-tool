'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createJobRequestSchema, retainerDiscountSchema } from '@/features/clients/client.types';
import { companySizeSchema } from '@/features/prospects/prospect.types';
import { serviceTypeSchema, type ServiceType } from '@/features/pricing/service-type';

// Local mirror of `app/api/pricing/catalog/route.ts`'s response shape.
// Deliberately not imported from `service-catalog.ts` (which pulls in
// `@/common/config/env`) — this is a `'use client'` file.
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

type CreateJobOutcome = 'created' | 'client_not_found' | 'invalid_input' | 'request_failed';

interface CreateJobFormProps {
  clientId: string;
  companySize: z.infer<typeof companySizeSchema>;
  onCreated: () => void;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function catalogHelpText(catalog: CatalogResponse, service: ServiceType): string | null {
  if (service === 'infra_hosting_retainer') {
    const range = catalog.infraHostingRetainerRange;
    return `Suggested range: ${formatCents(range.minCents)}–${formatCents(range.maxCents)}`;
  }

  const entry = catalog.services.find((item) => item.service === service);
  if (!entry) return null;
  if (entry.catalogEntry === 'manual_quote') return 'Manual quote — no suggested range for this company size.';
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
  const [outcome, setOutcome] = useState<CreateJobOutcome | null>(null);

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
      setOutcome('invalid_input');
      return;
    }

    setIsSubmitting(true);
    setOutcome(null);

    try {
      const response = await fetch(`/api/clients/${clientId}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });

      if (response.status === 404) {
        setOutcome('client_not_found');
        return;
      }

      if (response.status === 400) {
        setOutcome('invalid_input');
        return;
      }

      if (!response.ok) {
        setOutcome('request_failed');
        return;
      }

      const body: unknown = await response.json();
      const result = createJobResponseSchema.parse(body);
      setOutcome(result.outcome);
      setPriceDollars('');
      setNotes('');
      setRetainerDiscount('');
      onCreated();
    } catch {
      setOutcome('request_failed');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-md border border-border p-4">
      <h2 className="text-sm font-medium">Create job</h2>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Service</label>
        <Select value={service} onValueChange={(value) => setService(value as ServiceType)}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {serviceTypeSchema.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {catalog ? <p className="text-xs text-muted-foreground">{catalogHelpText(catalog, service)}</p> : null}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Agreed price (USD)</label>
        <Input
          type="number"
          min="0"
          step="0.01"
          className="w-40"
          value={priceDollars}
          onChange={(event) => setPriceDollars(event.target.value)}
          required
        />
      </div>

      {service === 'infra_hosting_retainer' ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Retainer discount</label>
          <Select
            value={retainerDiscount === '' ? 'none' : retainerDiscount}
            onValueChange={(value) =>
              setRetainerDiscount(value === 'none' ? '' : (value as z.infer<typeof retainerDiscountSchema>))
            }
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {retainerDiscountSchema.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Notes</label>
        <textarea
          className="w-full rounded-md border border-input bg-background p-2 text-sm"
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      <Button type="submit" disabled={isSubmitting} className="w-fit">
        {isSubmitting ? 'Creating…' : 'Create job'}
      </Button>

      {outcome === 'created' ? <p className="text-sm text-green-600">Job created.</p> : null}
      {outcome === 'client_not_found' ? <p className="text-sm text-destructive">Client not found.</p> : null}
      {outcome === 'invalid_input' ? <p className="text-sm text-destructive">Invalid input.</p> : null}
      {outcome === 'request_failed' ? <p className="text-sm text-destructive">Request failed.</p> : null}
    </form>
  );
}
