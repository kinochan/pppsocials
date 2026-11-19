import Link from "next/link";

export const metadata = {
  title: "Privacy Policy | PPP Socials",
  description: "How PPP Socials handles information in this deployment.",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-6 text-gray-900">
      <header className="space-y-2">
        <p className="text-sm text-gray-600">Last updated: November 19, 2026</p>
        <h1 className="text-3xl font-bold">Privacy Policy</h1>
        <p>
          This policy describes information handled by this PPP Socials
          deployment (the “Service”). The person or organization that hosts and
          administers it (“Operator”) determines how it is operated and is the
          contact for privacy requests. Ask the deployment administrator for
          the Operator’s identity and contact details.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Information the Service handles</h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Account and session information:</strong> your email
            address, authentication information, account status, and
            information needed to maintain your sign-in session.
          </li>
          <li>
            <strong>Video library information:</strong> uploaded video files,
            original filenames, titles, descriptions, and records used to
            organize and publish those videos. Signed-in users on a deployment
            may share its library.
          </li>
          <li>
            <strong>Connected-account information:</strong> account or channel
            details and authorization tokens for social media services you
            connect. Tokens are encrypted before they are stored by the
            Service.
          </li>
          <li>
            <strong>Operational information:</strong> information needed to
            authenticate requests, operate the Service, and diagnose errors.
            The hosting environment may also produce server or access logs
            according to the Operator’s configuration.
          </li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">How information is used and shared</h2>
        <p>
          The Service uses this information to authenticate users, provide the
          shared library, maintain connected accounts, carry out actions you
          confirm, protect the Service, and support its operation. The
          Operator and people who administer the hosting environment may have
          access to information stored or processed there.
        </p>
        <p>
          When you connect an account or choose to transfer or publish
          content, the Service exchanges information with the selected
          platform (such as Meta services, Google/YouTube, or TikTok), as
          needed for that action. Those providers handle information under
          their own privacy policies. The Service does not make the video
          library public; a TikTok Direct Post flow, if enabled, may create a
          temporary link to the specific video being posted.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Storage, cookies, and retention</h2>
        <p>
          Account and library records are stored in the database configured by
          the Operator. Uploaded video files are stored on the application
          server. The Service uses necessary authentication cookies to keep
          you signed in.
        </p>
        <p>
          Information remains in the Service until it is removed by an
          authorized user or administrator, or the Operator otherwise removes
          it. Backups and operational logs may persist according to the
          Operator’s retention practices. Removing a video from this Service
          does not remove copies already sent to a social media platform.
          Disconnecting an account in the Service does not necessarily revoke
          access at that platform; you can also review or revoke permissions
          through the platform.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Your choices and requests</h2>
        <p>
          You can sign out, manage content available to you in the library,
          and ask the Operator to correct or remove account information or
          connected-account data. The Operator can explain what information
          can be accessed or deleted and handle requests as required by
          applicable law. An administrator can disable accounts. There is no
          self-service public account registration or email-based password
          recovery in this deployment.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold">Security and changes</h2>
        <p>
          The Service uses access controls and encrypts stored social
          authorization tokens, but no system can be guaranteed completely
          secure. The Operator is responsible for configuring and protecting
          the server, database, backups, and network used for this deployment.
        </p>
        <p>
          The Operator may update this policy when the Service or its
          operation changes. Contact the deployment administrator with
          privacy questions or requests.
        </p>
      </section>

      <p className="text-sm text-gray-600">
        See also the <Link className="underline underline-offset-2" href="/tos">Terms of Service</Link>.
      </p>
    </main>
  );
}
