import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { CatalogCardView } from '../../../../components/card-details';

const flag = z.preprocess((v) => (v === true || v === 1 || v === '1' || v === 'true' ? true : undefined), z.boolean().optional());

export const Route = createFileRoute('/_tabs/cards/$language/$cardId')({
  validateSearch: z.object({
    variant: z.string().optional().catch(undefined),
    copy: z.string().optional().catch(undefined),
    zoom: flag.catch(undefined),
    add: flag.catch(undefined),
    menu: z.union([z.string(), z.number(), z.boolean()]).optional().catch(undefined)
  }),
  component: CardPage
});

function CardPage() {
  const { language, cardId } = Route.useParams();
  const search = Route.useSearch();
  const lang = language === 'ja' ? 'ja' : 'en';
  return <CatalogCardView language={lang} cardId={cardId} search={search} />;
}
