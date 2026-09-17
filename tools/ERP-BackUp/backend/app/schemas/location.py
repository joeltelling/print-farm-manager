from pydantic import BaseModel, ConfigDict


class LocationOut(BaseModel):
    id: int
    code: str

    model_config = ConfigDict(from_attributes=True)


class LocationCreate(BaseModel):
    code: str
