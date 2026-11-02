type Role = {
  role_id: string;
  name: string;
  personality: string;
};

type RoleSelectionPanelProps = {
  roles: Role[];
  selectedRoleId: string | null;
  onSelectRole: (roleId: string) => void;
  onConfirm: () => void;
};

export function RoleSelectionPanel({
  roles,
  selectedRoleId,
  onSelectRole,
  onConfirm
}: RoleSelectionPanelProps) {
  return (
    <main className="flex min-h-0 flex-col rounded-lg border border-ink/10 bg-white/90 shadow-panel">
      <header className="border-b border-ink/10 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brass">
          Role Selection
        </p>
        <h2 className="mt-1 text-xl font-semibold text-ink">选择你的角色</h2>
      </header>

      <div className="grid gap-3 overflow-y-auto p-5 md:grid-cols-2">
        {roles.map((role) => {
          const selected = role.role_id === selectedRoleId;

          return (
            <button
              key={role.role_id}
              className={[
                "rounded-lg border p-4 text-left transition",
                selected ? "border-pine bg-pine/10" : "border-ink/10 bg-paper/60 hover:border-pine/40"
              ].join(" ")}
              onClick={() => onSelectRole(role.role_id)}
            >
              <p className="text-base font-semibold text-ink">{role.name}</p>
              <p className="mt-2 text-sm leading-6 text-ink/70">{role.personality}</p>
            </button>
          );
        })}
      </div>

      <div className="border-t border-ink/10 p-5">
        <button
          className="h-11 rounded-md bg-pine px-5 text-sm font-semibold text-white transition hover:bg-pine/90 disabled:cursor-not-allowed disabled:bg-ink/25"
          disabled={!selectedRoleId}
          onClick={onConfirm}
        >
          确认选择角色
        </button>
      </div>
    </main>
  );
}
