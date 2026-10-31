import { Link, createFileRoute } from '@tanstack/react-router';
import { DatabaseZap, LayoutGrid } from 'lucide-react';
import { OwnedTile } from '../../components/owned';
import { Page } from '../../components/page';
import { ProgressCard } from '../../components/sync';
import { useToast } from '../../components/overlay';
import { Button, EmptyState, ErrorState, LinkButton, SectionTitle, Skeleton, StatTile, cx } from '../../components/ui';
import { useCatalogInstall, useCatalogStatus, useDashboard, useSettings, useSyncCapabilities, useUpdateOwnedPrices } from '../../data';
import { describeProgress } from '../../lib/catalog';
import { describeError, isCancelled } from '../../lib/errors';
import { formatInt, plural, formatMoney, formatSigned, LANGUAGE_NAMES, type Currency } from '../../lib/format';
import { useDelayedFlag } from '../../lib/hooks';
import { useNetwork } from '../../lib/native';

export const Route = createFileRoute('/_tabs/')({ component: Dashboard });

const SOURCE: Record<Currency, string> = { USD: 'TCGplayer', EUR: 'Cardmarket' };

function Dashboard() {
  const dash = useDashboard();
  const settings = useSettings();
  const en = useCatalogStatus('en');
  const ja = useCatalogStatus('ja');
  const install = useCatalogInstall();
  const net = useNetwork();
  const toast = useToast();
  const update = useUpdateOwnedPrices();
  const syncCaps = useSyncCapabilities();
  const showSkeleton = useDelayedFlag(dash.isPending);

  const catalogInstalled = en.data?.installed.status === 'installed' || ja.data?.installed.status === 'installed';
  const catalogKnown = en.isSuccess && ja.isSuccess;
  const d = dash.data;

  const updatePrices = async () => {
    if (!net.online) {
      toast.show({ message: 'You’re offline. Prices update when you’re connected.' });
      return;
    }
    try {
      await update.mutateAsync();
      toast.show({ message: 'Updating prices — progress shows below.' });
    } catch (e) {
      if (!isCancelled(e)) toast.show({ message: describeError(e).body, tone: 'negative' });
    }
  };

  return (
    <Page title="Dashboard" large add>
      <div className="flex flex-col gap-5 pt-1">
        {install.active && install.progress && (
          <ProgressCard
            title={`Downloading the ${LANGUAGE_NAMES[install.progress.language]} card catalog`}
            {...progressBits(install.progress)}
            actions={undefined}
          >
            <p className="mt-2 text-caption text-fg-muted">You can add custom cards or import a collection while you wait.</p>
          </ProgressCard>
        )}

        {dash.isError && <ErrorState error={dash.error} title="Couldn’t load your dashboard" body="Something went wrong reading your collection. Your data hasn’t changed." onRetry={() => void dash.refetch()} />}

        {dash.isPending && showSkeleton && (
          <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-9 w-44" />
            <Skeleton className="h-4 w-60" />
            <Skeleton className="h-4 w-52" />
            <div className="grid grid-cols-2 gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          </div>
        )}

        {d && (
          <div className="lg:grid lg:grid-cols-2 lg:gap-6">
            <ValueBlock d={d} onUpdate={() => void updatePrices()} updating={update.isPending} unavailable={syncCaps.pricesOnly ? null : (syncCaps.reason ?? 'Price updates aren’t available yet')} />
            <div className="mt-5 grid grid-cols-2 gap-2 lg:mt-0 [[data-text-size=ax]_&]:grid-cols-1" data-testid="stat-tiles">
              <StatTile label="Total cards" value={formatInt(d.totalCards)} to="/collection" />
              <StatTile label="Unique cards" value={formatInt(d.uniqueCards)} />
              <StatTile label="Duplicates" value={formatInt(d.duplicates)} to="/collection" search={{ dupes: true }} />
              <PaidTile d={d} />
            </div>
          </div>
        )}

        {catalogKnown && !catalogInstalled && !install.active && (
          <EmptyState
            icon={DatabaseZap}
            title="Download the card catalog"
            testId="no-catalog"
            body={`FlashyDex needs the card list before you can search. It downloads once (about 14 MB for English) and then works offline.${net.online ? '' : ' Connect to the internet to download it.'}`}
            action={
              <LinkButton to="/settings/catalog" variant="primary" full>
                Choose languages
              </LinkButton>
            }
            secondary={
              <LinkButton to="/settings/data" variant="text">
                Import a collection
              </LinkButton>
            }
          />
        )}

        {d && (
          <section aria-labelledby="recent-h">
            <div id="recent-h">
              <SectionTitle
                action={
                  d.recent.length > 0 ? (
                    <Link to="/collection" search={{ sort: 'created_desc' } as never} className="inline-flex min-h-(--ps-tap) items-center text-small text-accent-fg">
                      See all ›
                    </Link>
                  ) : undefined
                }
              >
                Recently added
              </SectionTitle>
            </div>
            {d.recent.length === 0 ? (
              catalogKnown && (catalogInstalled || install.active) ? (
                <EmptyState
                  icon={LayoutGrid}
                  title="Your collection is empty"
                  body="Search the catalog to add your first card."
                  action={
                    <LinkButton to="/add" variant="primary" full>
                      Add a card
                    </LinkButton>
                  }
                />
              ) : (
                <p className="py-4 text-small text-fg-muted">Nothing added yet.</p>
              )
            ) : (
              <ul aria-label="Recently added" className="scroll-hide -mx-4 mt-3 flex snap-x gap-2 overflow-x-auto px-4 pb-2 lg:mx-0 lg:grid lg:grid-cols-5 lg:overflow-visible lg:px-0 xl:grid-cols-10">
                {d.recent.map((o) => (
                  <li key={o.id} className="w-[104px] shrink-0 snap-start lg:w-auto">
                    <OwnedTile owned={o} currency={d.displayCurrency} showLang={false} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
      {settings.isSuccess && null}
    </Page>
  );
}

function progressBits(p: Parameters<typeof describeProgress>[1] & { language: 'en' | 'ja' }) {
  const d = describeProgress(p.language, p);
  return { line: d.line, stageLine: d.stage === 'downloading' ? 'Downloading' : d.stage === 'checking' ? 'Checking' : d.stage === 'installing' ? 'Installing' : 'Activating', value: d.value, max: d.max, valueText: d.valueText };
}

type Dash = NonNullable<ReturnType<typeof useDashboard>['data']>;

function ValueBlock({ d, onUpdate, updating, unavailable }: { d: Dash; onUpdate: () => void; updating: boolean; unavailable: string | null }) {
  const primary = d.currencies.find((c) => c.currency === d.displayCurrency);
  const other = d.currencies.find((c) => c.currency !== d.displayCurrency);
  const value = formatMoney(primary?.estimatedValueCents, d.displayCurrency);
  const otherValue = other ? formatMoney(other.estimatedValueCents, other.currency) : null;
  const gain = primary && primary.gainLossCents !== null && primary.gainLossCents !== undefined ? formatSigned(primary.gainLossCents, d.displayCurrency) : null;
  return (
    <section aria-label="Estimated value" data-testid="value-block">
      <div className="text-caption text-fg-muted">Estimated value</div>
      {d.totalCopies === 0 ? (
        <div className="mt-1 text-display text-fg-muted">No cards yet</div>
      ) : value ? (
        <div className="mt-1 text-display tabular-nums" data-testid="value-primary">
          {value}
        </div>
      ) : (
        <div className="mt-1 text-h2 font-semibold text-fg-muted">No price data yet</div>
      )}
      {d.totalCopies > 0 && (
        <>
          {gain && primary ? (
            <p className={cx('mt-1 text-small', gain.tone === 'positive' ? 'text-positive' : gain.tone === 'negative' ? 'text-negative' : 'text-fg-muted')} data-testid="gain-loss">
              <span className="sr-only">{gain.tone === 'negative' ? 'Loss of ' : 'Gain of '}</span>
              {gain.text} on {formatInt(primary.comparableCopies)} {primary.comparableCopies === 1 ? 'card' : 'cards'} with a known cost
            </p>
          ) : (
            <p className="mt-1 text-small text-fg-muted">
              <Link to="/collection" search={{ sort: 'created_desc' } as never} className="inline-flex min-h-(--ps-tap) items-center text-accent-fg">
                Add what you paid to see gain/loss
              </Link>
            </p>
          )}
          <Link to="/collection" search={{ priced: 'none' } as never} className="flex min-h-(--ps-tap) items-center text-caption text-fg-muted" data-testid="coverage">
            {formatInt(d.pricedCopies)} of {formatInt(d.totalCopies)} {d.totalCopies === 1 ? 'copy' : 'copies'} priced ›
          </Link>
          {otherValue && other && (
            <p className="text-small text-fg-muted" data-testid="value-secondary">
              {otherValue} from {SOURCE[other.currency]} prices
            </p>
          )}
          <p className="flex flex-wrap items-center gap-x-2 text-caption text-fg-subtle">
            <span>{SOURCE[d.displayCurrency]} prices</span>
            <Button variant="text" className="min-h-(--ps-tap) px-1 text-caption" loading={updating} softDisabled={unavailable !== null} aria-describedby={unavailable ? 'dash-update-reason' : undefined} onClick={onUpdate} aria-label="Update prices" data-testid="dash-update-prices">
              Update
            </Button>
            {unavailable && <span id="dash-update-reason" className="text-caption text-fg-muted" data-testid="dash-update-reason">{unavailable}</span>}
          </p>
        </>
      )}
    </section>
  );
}

function PaidTile({ d }: { d: Dash }) {
  const rows = d.currencies.filter((c) => c.totalPaidCents !== null && c.totalPaidCents !== undefined);
  const known = Math.max(0, ...rows.map((c) => c.knownCostCopies));
  return (
    <StatTile
      label="Total paid"
      value={
        rows.length === 0 ? (
          <span className="text-fg-muted">—</span>
        ) : (
          <span className="flex flex-col">
            {rows.map((c) => (
              <span key={c.currency}>{formatMoney(c.totalPaidCents, c.currency)}</span>
            ))}
          </span>
        )
      }
      sub={rows.length > 0 ? `known cost on ${formatInt(known)} of ${plural(d.totalCopies, 'card')}` : 'No purchase prices entered'}
    />
  );
}
