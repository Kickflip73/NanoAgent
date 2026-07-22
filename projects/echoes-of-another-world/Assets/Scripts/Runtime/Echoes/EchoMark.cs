using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Echoes
{
    public readonly struct EchoContext
    {
        public EchoContext(MonoBehaviour runner, Transform user, Vector2 direction)
        {
            Runner = runner;
            User = user;
            Direction = direction.sqrMagnitude > 0f ? direction.normalized : Vector2.right;
        }

        public MonoBehaviour Runner { get; }

        public Transform User { get; }

        public Vector2 Direction { get; }
    }

    public abstract class EchoMark : ScriptableObject
    {
        [SerializeField]
        private string id = string.Empty;

        [SerializeField]
        private string displayName = string.Empty;

        [SerializeField, Min(0f)]
        private float cooldown = 2f;

        public string Id => id;

        public string DisplayName => displayName;

        public float Cooldown => cooldown;

        public void Configure(string markId, string markName, float markCooldown)
        {
            id = markId;
            displayName = markName;
            cooldown = Mathf.Max(0f, markCooldown);
        }

        public abstract bool Activate(EchoContext context);
    }
}
