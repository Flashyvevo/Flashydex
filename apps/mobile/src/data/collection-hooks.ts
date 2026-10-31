import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type UseInfiniteQueryResult } from '@tanstack/react-query';
import type {
  AcquisitionDto, AcquisitionQuery, AcquisitionUpdate, BulkAdd, ById, CollectionCardGroup, CustomDto, CustomInput, CustomQuery, CustomUpdate,
  DomainError, GroupDto, Input, LocationDto, MembersInput, NamedInput, NamedQuery, NamedUpdate, OwnedCreate, OwnedDto, OwnedListQuery, OwnedUpdate, Page
} from '@flashydex/core';
import { useServices, useServicesIfReady } from './context';
import { invalidatePersonal, keys } from './keys';

type ListInput = Input<typeof OwnedListQuery>;
/** Collection query without paging: `useCollection` pages by itself (30 rows per page unless `limit` is given). */
export type CollectionQuery = Omit<ListInput, 'offset' | 'groupBy'>;

/**
 * Infinite collection list. Default `groupBy: 'card'` returns pages of `CollectionCardGroup` (one tile per language+card+variant);
 * `groupBy: 'copy'` returns pages of individual `OwnedDto`. Flatten with `data.pages.flatMap(p => p.data)`.
 */
export function useCollection(query?: CollectionQuery & { groupBy?: 'card' }): UseInfiniteQueryResult<InfiniteData<Page<CollectionCardGroup>>, DomainError>;
export function useCollection(query: CollectionQuery & { groupBy: 'copy' }): UseInfiniteQueryResult<InfiniteData<Page<OwnedDto>>, DomainError>;
export function useCollection(query: CollectionQuery & { groupBy?: 'card' | 'copy' } = {}) {
  const services = useServicesIfReady();
  return useInfiniteQuery<Page<CollectionCardGroup> | Page<OwnedDto>, DomainError, InfiniteData<Page<CollectionCardGroup> | Page<OwnedDto>>, ReturnType<typeof keys.collection>, number>({
    queryKey: keys.collection({ ...query, groupBy: query.groupBy ?? 'card' }),
    enabled: services !== null,
    initialPageParam: 0,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => (services as NonNullable<typeof services>).collection.list({ ...query, groupBy: query.groupBy ?? 'card', offset: pageParam }),
    getNextPageParam: (last) => (last.page.hasMore ? last.page.offset + last.data.length : undefined)
  });
}

export function useOwnedCopy(id: string | undefined) {
  const services = useServicesIfReady();
  return useQuery<OwnedDto, DomainError>({ queryKey: keys.copy(id ?? ''), enabled: services !== null && id !== undefined, queryFn: () => (services as NonNullable<typeof services>).collection.getCopy({ id: id as string }) });
}

export type AddCopiesInput = { quantity?: number; copy: Input<typeof OwnedCreate> };
/** Wraps `add` (quantity omitted/1) and `bulkAdd` (1..100). Resolves only after the durable commit; never retried automatically. */
export function useAddCopies() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<{ created: number; copies: OwnedDto[] }, DomainError, AddCopiesInput>({
    retry: false,
    mutationFn: async ({ quantity, copy }) => {
      if (quantity === undefined || quantity === 1) {
        const added = await services.collection.add(copy);
        return { created: 1, copies: [added] };
      }
      return services.collection.bulkAdd({ quantity, copy } as Input<typeof BulkAdd>);
    },
    onSuccess: () => invalidatePersonal(qc)
  });
}

export function useUpdateCopy() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<OwnedDto, DomainError, Input<typeof OwnedUpdate>>({ retry: false, mutationFn: (input) => services.collection.update(input), onSuccess: () => invalidatePersonal(qc) });
}

export function useRemoveCopy() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<void, DomainError, Input<typeof ById>>({ retry: false, mutationFn: (input) => services.collection.remove(input), onSuccess: () => invalidatePersonal(qc) });
}

/** Distinct (language,setId) of owned catalog copies: the selection `useUpdateOwnedPrices` uses. */
export function useOwnedSetKeys() {
  const services = useServicesIfReady();
  return useQuery<Array<{ language: 'en' | 'ja'; setId: string }>, DomainError>({ queryKey: keys.ownedSetKeys(), enabled: services !== null, queryFn: () => (services as NonNullable<typeof services>).collection.ownedSetKeys() });
}

/* ------------------------------------------------------------------------------------------ acquisitions */
export function useAcquisitions(q?: Input<typeof AcquisitionQuery>) {
  const services = useServicesIfReady();
  return useQuery<Page<AcquisitionDto>, DomainError>({ queryKey: keys.acquisitions(q), enabled: services !== null, placeholderData: keepPreviousData, queryFn: () => (services as NonNullable<typeof services>).collection.listAcquisitions(q ?? {}) });
}
export function useUpdateAcquisition() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<AcquisitionDto, DomainError, Input<typeof AcquisitionUpdate>>({ retry: false, mutationFn: (input) => services.collection.updateAcquisition(input), onSuccess: () => invalidatePersonal(qc) });
}

/* ------------------------------------------------------------------------------------------ locations */
export function useLocations(q?: Input<typeof NamedQuery>) {
  const services = useServicesIfReady();
  return useQuery<Page<LocationDto>, DomainError>({ queryKey: keys.locations(q), enabled: services !== null, placeholderData: keepPreviousData, queryFn: () => (services as NonNullable<typeof services>).collection.listLocations(q ?? {}) });
}
export function useCreateLocation() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<LocationDto, DomainError, Input<typeof NamedInput>>({ retry: false, mutationFn: (input) => services.collection.createLocation(input), onSuccess: () => invalidatePersonal(qc) });
}
export function useUpdateLocation() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<LocationDto, DomainError, Input<typeof NamedUpdate>>({ retry: false, mutationFn: (input) => services.collection.updateLocation(input), onSuccess: () => invalidatePersonal(qc) });
}
export function useRemoveLocation() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<void, DomainError, Input<typeof ById>>({ retry: false, mutationFn: (input) => services.collection.removeLocation(input), onSuccess: () => invalidatePersonal(qc) });
}

/* ------------------------------------------------------------------------------------------ groups */
export function useGroups(q?: Input<typeof NamedQuery>) {
  const services = useServicesIfReady();
  return useQuery<Page<GroupDto>, DomainError>({ queryKey: keys.groups(q), enabled: services !== null, placeholderData: keepPreviousData, queryFn: () => (services as NonNullable<typeof services>).collection.listGroups(q ?? {}) });
}
export function useCreateGroup() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<GroupDto, DomainError, Input<typeof NamedInput>>({ retry: false, mutationFn: (input) => services.collection.createGroup(input), onSuccess: () => invalidatePersonal(qc) });
}
export function useUpdateGroup() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<GroupDto, DomainError, Input<typeof NamedUpdate>>({ retry: false, mutationFn: (input) => services.collection.updateGroup(input), onSuccess: () => invalidatePersonal(qc) });
}
export function useRemoveGroup() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<void, DomainError, Input<typeof ById>>({ retry: false, mutationFn: (input) => services.collection.removeGroup(input), onSuccess: () => invalidatePersonal(qc) });
}
/** Extras beyond the minimal surface: bulk group membership. */
export function useAddGroupMembers() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<GroupDto, DomainError, Input<typeof MembersInput>>({ retry: false, mutationFn: (input) => services.collection.addMembers(input), onSuccess: () => invalidatePersonal(qc) });
}
export function useRemoveGroupMembers() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<GroupDto, DomainError, Input<typeof MembersInput>>({ retry: false, mutationFn: (input) => services.collection.removeMembers(input), onSuccess: () => invalidatePersonal(qc) });
}

/* ------------------------------------------------------------------------------------------ custom cards */
export function useCustomCard(id: string | undefined) {
  const services = useServicesIfReady();
  return useQuery<CustomDto, DomainError>({ queryKey: keys.custom(id ?? ''), enabled: services !== null && id !== undefined, queryFn: () => (services as NonNullable<typeof services>).collection.getCustom({ id: id as string }) });
}
/** Extra: list/search custom definitions (e.g. to pick one when adding a copy). */
export function useCustomCards(q?: Input<typeof CustomQuery>) {
  const services = useServicesIfReady();
  return useQuery<Page<CustomDto>, DomainError>({ queryKey: keys.customList(q), enabled: services !== null, placeholderData: keepPreviousData, queryFn: () => (services as NonNullable<typeof services>).collection.listCustom(q ?? {}) });
}
export function useCreateCustomCard() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<CustomDto, DomainError, Input<typeof CustomInput>>({ retry: false, mutationFn: (input) => services.collection.createCustom(input), onSuccess: () => invalidatePersonal(qc) });
}
export function useUpdateCustomCard() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<CustomDto, DomainError, Input<typeof CustomUpdate>>({ retry: false, mutationFn: (input) => services.collection.updateCustom(input), onSuccess: () => invalidatePersonal(qc) });
}
export function useRemoveCustomCard() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<void, DomainError, Input<typeof ById>>({ retry: false, mutationFn: (input) => services.collection.removeCustom(input), onSuccess: () => invalidatePersonal(qc) });
}
