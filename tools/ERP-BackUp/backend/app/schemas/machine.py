from pydantic import BaseModel, ConfigDict, Field

class MachineIn(BaseModel):
    machine: str = Field(min_length=1)
    hourly_rate: float = Field(ge=0)

class MachineOut(MachineIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    is_active: bool = True
