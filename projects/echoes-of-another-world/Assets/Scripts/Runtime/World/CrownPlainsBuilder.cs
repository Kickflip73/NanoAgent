using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Tilemaps;

namespace EchoesOfAnotherWorld.Runtime.World
{
    public static class CrownPlainsBuilder
    {
        public const int ChunkSize = 16;

        public static IReadOnlyList<WorldChunk> Build(Transform parent)
        {
            Sprite tileSprite = CreateSquareSprite(32, 32f);
            Tile grass = CreateTile(tileSprite, new Color(0.32f, 0.58f, 0.25f));
            Tile alternateGrass = CreateTile(tileSprite, new Color(0.37f, 0.64f, 0.28f));
            Tile path = CreateTile(tileSprite, new Color(0.68f, 0.57f, 0.38f));
            Tile tree = CreateTile(tileSprite, new Color(0.08f, 0.3f, 0.12f));
            Tile wall = CreateTile(tileSprite, new Color(0.44f, 0.29f, 0.18f));
            Tile roof = CreateTile(tileSprite, new Color(0.58f, 0.17f, 0.13f));

            GameObject gridObject = new GameObject("王冠平原 Tilemap Grid");
            gridObject.transform.SetParent(parent, false);
            gridObject.AddComponent<Grid>().cellSize = Vector3.one;

            List<WorldChunk> chunks = new List<WorldChunk>();
            for (int chunkY = -2; chunkY <= 2; chunkY++)
            {
                for (int chunkX = -2; chunkX <= 2; chunkX++)
                {
                    Vector2Int coordinate = new Vector2Int(chunkX, chunkY);
                    chunks.Add(CreateChunk(
                        gridObject.transform,
                        coordinate,
                        grass,
                        alternateGrass,
                        path,
                        tree,
                        wall,
                        roof));
                }
            }

            return chunks;
        }

        private static WorldChunk CreateChunk(
            Transform grid,
            Vector2Int coordinate,
            Tile grass,
            Tile alternateGrass,
            Tile path,
            Tile tree,
            Tile wall,
            Tile roof)
        {
            GameObject chunkObject = new GameObject();
            chunkObject.transform.SetParent(grid, false);
            chunkObject.transform.localPosition = new Vector3(
                coordinate.x * ChunkSize,
                coordinate.y * ChunkSize,
                0f);
            WorldChunk chunk = chunkObject.AddComponent<WorldChunk>();
            chunk.Configure(coordinate, ChunkSize);

            Tilemap ground = CreateTilemap("草地与道路", chunkObject.transform, 0);
            Tilemap details = CreateTilemap("树木与城镇", chunkObject.transform, 1);
            for (int y = 0; y < ChunkSize; y++)
            {
                for (int x = 0; x < ChunkSize; x++)
                {
                    int worldX = coordinate.x * ChunkSize + x;
                    int worldY = coordinate.y * ChunkSize + y;
                    Vector3Int cell = new Vector3Int(x, y, 0);
                    bool onPath = Mathf.Abs(worldX) <= 1 || Mathf.Abs(worldY) <= 1;
                    TileBase groundTile = onPath
                        ? path
                        : ((worldX * 17 + worldY * 31) & 7) == 0 ? alternateGrass : grass;
                    ground.SetTile(cell, groundTile);

                    bool nearTown = Mathf.Abs(worldX) < 9 && Mathf.Abs(worldY) < 8;
                    int treeNoise = Mathf.Abs(worldX * 37 + worldY * 19);
                    if (!onPath && !nearTown && treeNoise % 23 == 0)
                    {
                        details.SetTile(cell, tree);
                    }
                }
            }

            if (coordinate == Vector2Int.zero)
            {
                PaintTown(details, wall, roof);
            }

            return chunk;
        }

        private static void PaintTown(Tilemap details, Tile wall, Tile roof)
        {
            PaintBuilding(details, new Vector2Int(3, 3), 4, 3, wall, roof);
            PaintBuilding(details, new Vector2Int(10, 3), 4, 3, wall, roof);
            PaintBuilding(details, new Vector2Int(3, 10), 4, 3, wall, roof);
            PaintBuilding(details, new Vector2Int(10, 10), 4, 3, wall, roof);
        }

        private static void PaintBuilding(
            Tilemap tilemap,
            Vector2Int origin,
            int width,
            int height,
            Tile wall,
            Tile roof)
        {
            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    tilemap.SetTile(
                        new Vector3Int(origin.x + x, origin.y + y, 0),
                        y == height - 1 ? roof : wall);
                }
            }
        }

        private static Tilemap CreateTilemap(string objectName, Transform parent, int order)
        {
            GameObject tilemapObject = new GameObject(objectName);
            tilemapObject.transform.SetParent(parent, false);
            Tilemap tilemap = tilemapObject.AddComponent<Tilemap>();
            TilemapRenderer renderer = tilemapObject.AddComponent<TilemapRenderer>();
            renderer.sortingLayerName = order == 0 ? "Ground" : "Buildings";
            renderer.sortingOrder = order;
            return tilemap;
        }

        private static Tile CreateTile(Sprite sprite, Color color)
        {
            Tile tile = ScriptableObject.CreateInstance<Tile>();
            tile.sprite = sprite;
            tile.color = color;
            tile.colliderType = Tile.ColliderType.None;
            return tile;
        }

        private static Sprite CreateSquareSprite(int pixelSize, float pixelsPerUnit)
        {
            Texture2D texture = new Texture2D(pixelSize, pixelSize, TextureFormat.RGBA32, false);
            texture.name = "Runtime Tile Texture";
            texture.filterMode = FilterMode.Point;
            Color[] pixels = new Color[pixelSize * pixelSize];
            for (int index = 0; index < pixels.Length; index++)
            {
                pixels[index] = Color.white;
            }

            texture.SetPixels(pixels);
            texture.Apply();
            return Sprite.Create(
                texture,
                new Rect(0f, 0f, pixelSize, pixelSize),
                new Vector2(0.5f, 0.5f),
                pixelsPerUnit);
        }
    }
}
