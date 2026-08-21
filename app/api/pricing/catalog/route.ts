import { NextRequest, NextResponse } from 'next/server';

import { companySizeSchema } from '@/features/prospects/prospect.types';
import {
  getCatalogEntry,
  getInfraHostingRetainerRange,
  getServiceCadence,
  type ServiceType,
} from '@/features/pricing/service-catalog';

// The three services with a company-size-tiered price; `infra_hosting_retainer`
// has its own flat range, returned separately below.
const TIERED_SERVICES: ReadonlyArray<
  Extract<ServiceType, 'landing_page' | 'full_stack_app' | 'linkedin_media_management'>
> = ['landing_page', 'full_stack_app', 'linkedin_media_management'];

/**
 * Read-only pricing catalog lookup for the dashboard's Create Job form: for
 * a given `companySize`, returns each tiered service's suggested price range
 * (or `'manual_quote'`) plus its cadence, and the flat
 * `infra_hosting_retainer` range. Server-only route handler, so it's safe to
 * import `service-catalog.ts` directly (which pulls in `@/common/config/env`)
 * - that import must never reach a `'use client'` file.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = companySizeSchema.safeParse(request.nextUrl.searchParams.get('companySize'));
  if (!parsed.success) {
    return NextResponse.json({ error: 'companySize is required.' }, { status: 400 });
  }

  const companySize = parsed.data;
  const services = TIERED_SERVICES.map((service) => ({
    service,
    cadence: getServiceCadence(service),
    catalogEntry: getCatalogEntry(service, companySize),
  }));

  return NextResponse.json({
    services,
    infraHostingRetainerRange: getInfraHostingRetainerRange(),
  });
}
