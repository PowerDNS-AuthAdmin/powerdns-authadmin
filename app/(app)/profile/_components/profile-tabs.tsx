/**
 * app/(app)/profile/_components/profile-tabs.tsx
 *
 * Re-export shim — the implementation moved to
 * `components/ui/section-tabs.tsx` once /admin/users/[id] grew the
 * same tab layout. Kept here so existing imports
 * (`ProfileTabsContainer`, `ProfileTabPanel`) still resolve.
 */

export {
  SectionTabs as ProfileTabsContainer,
  SectionTabPanel as ProfileTabPanel,
  type SectionTabSpec as TabSpec,
} from "@/components/ui/section-tabs";
