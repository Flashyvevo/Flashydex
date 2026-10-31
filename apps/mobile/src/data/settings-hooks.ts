import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppSettings, DashboardDto, DomainError, Input, SettingsPatch, DashboardInput } from '@flashydex/core';
import { useServices, useServicesIfReady } from './context';
import { invalidateAll, keys } from './keys';

export function useSettings() {
  const services = useServicesIfReady();
  return useQuery<AppSettings, DomainError>({ queryKey: keys.settings(), enabled: services !== null, queryFn: () => (services as NonNullable<typeof services>).settings.get({}) });
}

/** Settings never change the collection revision; they change defaults used by lists/dashboard, so those refetch. */
export function useUpdateSettings() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<AppSettings, DomainError, Input<typeof SettingsPatch>>({
    mutationFn: (patch) => services.settings.update(patch),
    onSuccess: async (settings) => {
      qc.setQueryData(keys.settings(), settings);
      await invalidateAll(qc);
    }
  });
}

export function useDashboard(input?: Input<typeof DashboardInput>) {
  const services = useServicesIfReady();
  return useQuery<DashboardDto, DomainError>({ queryKey: keys.dashboard(input), enabled: services !== null, queryFn: () => (services as NonNullable<typeof services>).portfolio.dashboard(input ?? {}) });
}
