"""Candidate transport fix, exercised only inside the task's isolated engine."""
import asyncio

async def bridge(websocket, agen):
    """Stop a quiet upstream immediately when its browser closes the websocket."""
    async def forward():
        async for item in agen:
            if 'error' in item:
                await websocket.send_json({'type':'error','message':item['error']})
                return
            await websocket.send_json({**item,'type':'tick'})

    async def disconnected():
        while True:
            message = await websocket.receive()
            if message['type'] == 'websocket.disconnect':
                return

    producer = asyncio.create_task(forward())
    receiver = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait((producer, receiver), return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in (producer, receiver):
            task.cancel()
        await asyncio.gather(producer, receiver, return_exceptions=True)
        await agen.aclose()

