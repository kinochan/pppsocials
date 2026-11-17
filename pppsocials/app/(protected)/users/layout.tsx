import AdminGuard from "@/app/components/AdminGuard";

export default function UsersLayout({ children }: { children: React.ReactNode }) {
  return <AdminGuard>{children}</AdminGuard>;
}
