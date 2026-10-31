import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { OnboardingShell } from '../../../components/onboarding-shell';
import { SetPicker, setKeyString, type SetKey } from '../../../components/set-picker';
import { useToast } from '../../../components/overlay';
import { Button, SegmentedControl } from '../../../components/ui';
import { useCatalogInstall, useSettings, useUpdateSettings } from '../../../data';
import { formatInt, type Language } from '../../../lib/format';

export const Route = createFileRoute('/_modal/welcome/sets')({ component: Sets });

function Sets() {
  const navigate = useNavigate();
  const settings = useSettings();
  const update = useUpdateSettings();
  const install = useCatalogInstall();
  const toast = useToast();
  const [mode, setMode] = useState<'all' | 'pick'>('all');
  const [picked, setPicked] = useState<Map<string, SetKey>>(new Map());
  const languages = (settings.data?.languages ?? ['en']) as Language[];

  const toggle = (k: SetKey) =>
    setPicked((cur) => {
      const next = new Map(cur);
      const key = setKeyString(k);
      if (next.has(key)) next.delete(key);
      else next.set(key, k);
      return next;
    });

  const start = async (all: boolean) => {
    try {
      const chosen = [...picked.values()];
      await update.mutateAsync({
        languages,
        ...(all || chosen.length === 0 ? { syncAllSets: true, setsFollowed: [] } : { syncAllSets: false, setsFollowed: chosen }),
        onboardingCompleted: true,
        disclaimerAcknowledged: true
      });
    } catch {
      toast.show({ message: 'Couldn’t save your choice. Try again.', tone: 'negative' });
      return;
    }
    // One global install at a time (D12): chain the languages; the promise outlives this screen.
    void (async () => {
      for (const l of languages) {
        const result = await install.start(l);
        if (result === null) break;
      }
    })();
    void navigate({ to: '/', replace: true });
  };

  return (
    <OnboardingShell
      step={4}
      title="Which sets do you collect?"
      body="This helps FlashyDex show your sets first and keep their prices fresh. It doesn’t change the download."
      footer={
        <>
          <Button variant="primary" full data-testid="onboarding-finish" loading={update.isPending} disabled={!settings.isSuccess} onClick={() => void start(mode === 'all')}>
            Start download
          </Button>
          <Button variant="text" disabled={update.isPending || !settings.isSuccess} onClick={() => void start(true)}>
            Skip this step
          </Button>
        </>
      }
    >
      <SegmentedControl
        label="Sets scope"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'all', label: 'All sets', aria: 'All sets', testId: 'sets-all' },
          { value: 'pick', label: 'Only sets I pick', aria: 'Only sets I pick', testId: 'sets-pick' }
        ]}
      />
      {mode === 'pick' && (
        <>
          <SetPicker languages={languages} selected={new Set(picked.keys())} onToggle={toggle} hideTcgPocket={settings.data?.hideTcgPocket ?? true} />
          <p className="text-caption text-fg-muted" aria-live="polite">
            {formatInt(picked.size)} {picked.size === 1 ? 'set' : 'sets'} selected
          </p>
        </>
      )}
    </OnboardingShell>
  );
}
