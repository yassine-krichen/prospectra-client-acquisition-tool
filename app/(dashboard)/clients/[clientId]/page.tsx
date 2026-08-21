import { ClientDetail } from '@/features/clients/client-detail';

interface ClientPageProps {
  params: Promise<{ clientId: string }>;
}

export default async function ClientPage({ params }: ClientPageProps): Promise<React.JSX.Element> {
  const { clientId } = await params;
  return <ClientDetail clientId={clientId} />;
}
