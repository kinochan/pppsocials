import Link from "next/link";

export const metadata = {
  title: "Terms of Service | PPP Socials",
  description: "Terms for using PPP Socials.",
};

export default function TermsOfServicePage() {
  return (
    <main className="mx-auto max-w-3xl space-y-6 text-gray-900">
      <header className="space-y-2">
        <p className="text-sm text-gray-600">Last updated: November 19, 2026</p>
        <h1 className="text-3xl font-bold">Terms of Service</h1>
        <p>
          These terms apply to your use of this PPP Socials deployment (the
          “Service”). By using the Service, you agree to these terms. If you do
          not agree, do not use it.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">1. The Service and your account</h2>
        <p>
          PPP Socials helps authorized users store videos and send them to
          connected social media accounts. The organization or person operating
          this deployment (“Operator”) controls access. There is no public
          sign-up; an Operator administrator creates and manages accounts.
        </p>
        <p>
          Accounts on this deployment may share the same video library and
          connected social accounts. Use the Service only if the Operator has
          authorized you to access that shared content and those accounts.
          Keep your sign-in details private and tell the Operator if you believe
          someone else has accessed your account.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">2. Your content and permissions</h2>
        <p>
          You are responsible for the videos, titles, descriptions, accounts,
          and other material you submit or publish through the Service. You
          must have all rights, permissions, and legal authority needed to
          upload that material and to direct its transfer or publication.
        </p>
        <p>
          Do not use the Service unlawfully, infringe another person’s rights,
          bypass access controls, or interfere with the Service or its users.
          You must follow the terms, policies, and applicable laws of each
          social media platform you connect to.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">3. Connected platforms and publishing</h2>
        <p>
          Connecting a social media account authorizes the Service to use the
          permissions you grant for the features you choose. When you confirm a
          transfer or post, the Service sends the relevant content and
          information to the selected platform. That platform handles the
          content under its own terms and privacy policy.
        </p>
        <p>
          A successful transfer does not guarantee that a platform will
          publish, display, or keep content available. Platform review,
          processing, privacy settings, outages, or policy decisions may affect
          the result. Check the destination account before retrying an
          uncertain operation, since a retry may create a duplicate.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">4. Availability and access</h2>
        <p>
          The Operator may change, suspend, or end the Service or your access to
          it. An administrator may disable accounts. The Service is provided
          on an “as available” basis; uninterrupted or error-free operation is
          not guaranteed. To the extent permitted by law, the Operator
          disclaims implied warranties and is not responsible for indirect or
          consequential loss arising from use of the Service.
        </p>
        <p>
          Nothing in these terms limits rights or remedies that cannot legally
          be limited. The Operator may provide additional terms or instructions
          for this deployment; those apply alongside these terms.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">5. Contact</h2>
        <p>
          Contact the administrator of this PPP Socials deployment with
          questions about these terms or your access. For information about
          personal data, see the <Link className="underline underline-offset-2" href="/policy">Privacy Policy</Link>.
        </p>
      </section>
    </main>
  );
}
