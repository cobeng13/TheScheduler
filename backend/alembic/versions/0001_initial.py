from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "schedule_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("program", sa.String(), nullable=False),
        sa.Column("section", sa.String(), nullable=False),
        sa.Column("course_code", sa.String(), nullable=False),
        sa.Column("course_description", sa.String(), nullable=False),
        sa.Column("units", sa.Float(), nullable=False),
        sa.Column("hours", sa.Float(), nullable=False),
        sa.Column("time_lpu", sa.String(), nullable=False),
        sa.Column("time_24", sa.String(), nullable=False),
        sa.Column("days", sa.String(), nullable=False),
        sa.Column("room", sa.String(), nullable=False),
        sa.Column("faculty", sa.String(), nullable=False),
        sa.Column("start_minutes", sa.Integer(), nullable=False),
        sa.Column("end_minutes", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "sections",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False, unique=True),
    )
    op.create_table(
        "faculty",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False, unique=True),
    )
    op.create_table(
        "rooms",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False, unique=True),
    )


def downgrade() -> None:
    op.drop_table("rooms")
    op.drop_table("faculty")
    op.drop_table("sections")
    op.drop_table("schedule_entries")
