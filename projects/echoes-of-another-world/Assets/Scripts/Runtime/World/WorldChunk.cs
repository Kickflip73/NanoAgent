using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.World
{
    public sealed class WorldChunk : MonoBehaviour
    {
        public Vector2Int Coordinate { get; private set; }

        public int Size { get; private set; }

        public void Configure(Vector2Int coordinate, int size)
        {
            Coordinate = coordinate;
            Size = size;
            name = $"王冠平原 Chunk {coordinate.x},{coordinate.y}";
        }
    }
}
