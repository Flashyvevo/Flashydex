import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { dataQueryKeys, useServices } from '../data';

type AcqInput = { purchasedOn: string | null; source: string | null; notes: string | null };

/** Acquisition writes the hook surface doesn't wrap (create/update a shared purchase event). Goes through the services escape hatch. */
export function useAcquisitionsServices() {
  const services = useServices();
  const qc = useQueryClient();
  const refresh = useCallback(async () => {
    await qc.invalidateQueries();
  }, [qc]);
  return {
    refresh,
    create: async (input: AcqInput): Promise<string> => {
      const acq = await services.collection.createAcquisition(input);
      return acq.id;
    },
    update: async (id: string, patch: Partial<AcqInput>): Promise<void> => {
      await services.collection.updateAcquisition({ id, patch });
      await qc.invalidateQueries();
    },
    keys: dataQueryKeys
  };
}
