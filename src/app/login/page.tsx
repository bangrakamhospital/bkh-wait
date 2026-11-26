import { LoginForm } from "@/components/LoginForm";
import { Card } from "@/components/ui";

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-sm">
      <Card title="เข้าสู่ระบบ">
        <LoginForm />
      </Card>
    </div>
  );
}
