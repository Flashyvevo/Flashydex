import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { OnboardingShell } from '../../../components/onboarding-shell';
import { useToast } from '../../../components/overlay';
import { Button } from '../../../components/ui';
import { useUpdateSettings } from '../../../data';
import { DISCLAIMER } from '../../../lib/legal';

export const Route = createFileRoute('/_modal/welcome/notice')({ component: Notice });

function Notice() {
  const navigate = useNavigate();
  const update = useUpdateSettings();
  const toast = useToast();
  const next = async () => {
    try {
      await update.mutateAsync({ disclaimerAcknowledged: true });
      void navigate({ to: '/welcome/languages' });
    } catch {
      toast.show({ message: 'Couldn’t save that choice. Try again.', tone: 'negative' });
    }
  };
  return (
    <OnboardingShell
      step={2}
      title="Before you start"
      footer={
        <Button variant="primary" full data-testid="notice-continue" loading={update.isPending} onClick={() => void next()}>
          Continue
        </Button>
      }
    >
      <div data-testid="about-disclaimer" className="selectable rounded-lg bg-surface p-4 text-body">
        {DISCLAIMER}
      </div>
      <div className="flex flex-col gap-2 text-body text-fg-muted">
        <p>Card data, images and prices come from TCGdex, a community database. Prices come from TCGplayer and Cardmarket and may be out of date.</p>
        <p>Your collection stays on this device. FlashyDex doesn’t collect any data.</p>
      </div>
      <Link to="/settings/privacy" className="inline-flex min-h-(--ps-tap) items-center self-start text-body text-accent-fg">
        Read the privacy policy ›
      </Link>
    </OnboardingShell>
  );
}
