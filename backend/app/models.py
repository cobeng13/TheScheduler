from __future__ import annotations

from sqlalchemy import Column, DateTime, Float, Integer, String, Text
from sqlalchemy.sql import func

from .db import Base


class ScheduleEntry(Base):
    __tablename__ = "schedule_entries"

    id = Column(Integer, primary_key=True, index=True)
    program = Column(String, nullable=False)
    section = Column(String, nullable=False)
    course_code = Column(String, nullable=False)
    course_description = Column(String, nullable=False)
    units = Column(Float, nullable=False)
    hours = Column(Float, nullable=False)
    time_lpu = Column(String, nullable=False)
    time_24 = Column(String, nullable=True)
    days = Column(String, nullable=False)
    room = Column(String, nullable=False)
    faculty = Column(String, nullable=False)
    start_minutes = Column(Integer, nullable=True)
    end_minutes = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())


class Section(Base):
    __tablename__ = "sections"

    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True, nullable=False)


class Faculty(Base):
    __tablename__ = "faculty"

    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True, nullable=False)


class Room(Base):
    __tablename__ = "rooms"

    id = Column(Integer, primary_key=True)
    name = Column(String, unique=True, nullable=False)


class AppSettings(Base):
    __tablename__ = "app_settings"

    id = Column(Integer, primary_key=True)
    settings_json = Column(Text, nullable=False, default="{}")
