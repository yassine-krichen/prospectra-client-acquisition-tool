import { DashboardNav } from '@/features/navigation/dashboard-nav';

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="flex min-h-screen">
      <DashboardNav />
      <div className="flex-1">{children}</div>
    </div>
  );
}
