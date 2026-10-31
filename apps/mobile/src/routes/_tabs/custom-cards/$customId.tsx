import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { CustomCardView } from '../../../components/custom-card-view';

const flag = z.preprocess((v) => (v === true || v === 1 || v === '1' || v === 'true' ? true : undefined), z.boolean().optional());

export const Route = createFileRoute('/_tabs/custom-cards/$customId')({
  validateSearch: z.object({ edit: flag.catch(undefined), copy: z.string().optional().catch(undefined), add: flag.catch(undefined) }),
  component: CustomPage
});

function CustomPage() {
  const { customId } = Route.useParams();
  const search = Route.useSearch();
  return <CustomCardView id={customId} search={search} />;
}
