import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { DatabaseZap, HardDrive, Layers } from 'lucide-react';
import { Mark, OnboardingShell } from '../../../components/onboarding-shell';
import { Button } from '../../../components/ui';

export const Route = createFileRoute('/_modal/welcome/')({ component: Welcome });

function Welcome() {
  const navigate = useNavigate();
  const rows = [
    { icon: Layers, text: 'Search every English and Japanese card' },
    { icon: DatabaseZap, text: 'Track copies, condition, grades and what you paid' },
    { icon: HardDrive, text: 'Everything stays on this device — no account, works offline' }
  ];
  return (
    <OnboardingShell
      step={1}
      title="Your card collection, in your pocket"
      hero={
        <div className="flex justify-center py-4">
          <Mark size={96} />
        </div>
      }
      footer={
        <>
          <Button variant="primary" full data-testid="welcome-start" onClick={() => void navigate({ to: '/welcome/notice' })}>
            Get started
          </Button>
          <Button variant="text" onClick={() => void navigate({ to: '/settings/data', search: { sheet: 'restore' } as never })}>
            Restore from a backup
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-4">
        {rows.map((r) => (
          <li key={r.text} className="flex items-start gap-3 text-body text-fg-muted">
            <r.icon size={24} className="mt-0.5 shrink-0" aria-hidden />
            {r.text}
          </li>
        ))}
      </ul>
    </OnboardingShell>
  );
}
