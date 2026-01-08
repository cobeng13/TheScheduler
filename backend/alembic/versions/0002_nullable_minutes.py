from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("schedule_entries") as batch_op:
        batch_op.alter_column("time_24", existing_type=sa.String(), nullable=True)
        batch_op.alter_column("start_minutes", existing_type=sa.Integer(), nullable=True)
        batch_op.alter_column("end_minutes", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    with op.batch_alter_table("schedule_entries") as batch_op:
        batch_op.alter_column("end_minutes", existing_type=sa.Integer(), nullable=False)
        batch_op.alter_column("start_minutes", existing_type=sa.Integer(), nullable=False)
        batch_op.alter_column("time_24", existing_type=sa.String(), nullable=False)
