using System.Collections.Generic;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.World
{
    public sealed class WorldStreamer : MonoBehaviour
    {
        private readonly Dictionary<Vector2Int, WorldChunk> chunks =
            new Dictionary<Vector2Int, WorldChunk>();

        private Transform player;
        private int chunkSize;
        private Vector2Int activeCenter = new Vector2Int(int.MinValue, int.MinValue);

        public int ActiveChunkCount { get; private set; }

        public void Configure(Transform playerTransform, int size, IEnumerable<WorldChunk> worldChunks)
        {
            player = playerTransform;
            chunkSize = Mathf.Max(1, size);
            chunks.Clear();
            foreach (WorldChunk chunk in worldChunks)
            {
                chunks[chunk.Coordinate] = chunk;
                chunk.gameObject.SetActive(false);
            }

            Refresh(force: true);
        }

        private void Update()
        {
            Refresh(force: false);
        }

        private void Refresh(bool force)
        {
            if (player == null)
            {
                return;
            }

            Vector2Int center = new Vector2Int(
                Mathf.FloorToInt(player.position.x / chunkSize),
                Mathf.FloorToInt(player.position.y / chunkSize));
            if (!force && center == activeCenter)
            {
                return;
            }

            activeCenter = center;
            ActiveChunkCount = 0;
            foreach (KeyValuePair<Vector2Int, WorldChunk> pair in chunks)
            {
                Vector2Int delta = pair.Key - center;
                bool shouldBeActive = Mathf.Abs(delta.x) <= 1 && Mathf.Abs(delta.y) <= 1;
                pair.Value.gameObject.SetActive(shouldBeActive);
                if (shouldBeActive)
                {
                    ActiveChunkCount++;
                }
            }
        }
    }
}
