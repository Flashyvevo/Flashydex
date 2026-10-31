import { createFileRoute } from '@tanstack/react-router';
import { CopyDeepLink } from '../../../components/card-details';

export const Route = createFileRoute('/_tabs/collection/$ownedId')({ component: DeepLink });

function DeepLink() {
  const { ownedId } = Route.useParams();
  return <CopyDeepLink ownedId={ownedId} />;
}
