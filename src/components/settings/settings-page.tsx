import { ChangePasswordForm } from "@/components/settings/change-password-form";
import { DeleteAccount } from "@/components/settings/delete-account";
import { TwoFactorSection } from "@/components/settings/two-factor-section";
import { ExportData } from "@/components/settings/export-data";
import { FormatsSection } from "@/components/settings/formats-section";
import { CategoriesSection } from "@/components/settings/categories-section";
import { RulesSection } from "@/components/settings/rules-section";
import { MenuPagesSection } from "@/components/settings/menu-pages-section";
import { SettingsMenuList, SettingsPageFrame } from "@/components/settings/settings-nav";
import {
  GetTheAppSection,
  HealthSection,
  NotificationsSection,
} from "@/components/health/health-section";
import { isDemoMode } from "@/lib/demo/mode";

/** /settings on a phone: the list of sections (desktop goes straight to Overview). */
export function SettingsIndexPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-8 md:py-12">
      <h1 className="ios-large-title">Settings</h1>
      <SettingsMenuList />
    </div>
  );
}

export function OverviewSettingsPage() {
  return (
    <SettingsPageFrame title="General">
      {/* Health first: it answers "can I trust these numbers?" (#14). */}
      <HealthSection />
      <FormatsSection />
      <NotificationsSection />
      <GetTheAppSection />
    </SettingsPageFrame>
  );
}

export function AppSettingsPage() {
  return (
    <SettingsPageFrame title="App">
      <MenuPagesSection />
    </SettingsPageFrame>
  );
}

export function PersonalizationSettingsPage() {
  return (
    <SettingsPageFrame title="Personalization">
      <CategoriesSection />
      <RulesSection />
    </SettingsPageFrame>
  );
}

// The demo has no real account: a password change or account deletion would do nothing and an
// export would be fake data.
const DemoNote = () => (
  <p className="text-sm text-muted-foreground">
    Not available in the demo: it has no real account.
  </p>
);

export function SecuritySettingsPage() {
  return (
    <SettingsPageFrame title="Security">
      {isDemoMode() ? (
        <DemoNote />
      ) : (
        <div className="space-y-4">
          <ChangePasswordForm />
          <TwoFactorSection />
        </div>
      )}
    </SettingsPageFrame>
  );
}

export function AccountSettingsPage() {
  return (
    <SettingsPageFrame title="Account">
      {isDemoMode() ? (
        <DemoNote />
      ) : (
        <div className="space-y-4">
          <ExportData />
          <DeleteAccount />
        </div>
      )}
    </SettingsPageFrame>
  );
}
