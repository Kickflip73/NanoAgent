using System.Collections;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime
{
    [RequireComponent(typeof(Rigidbody2D))]
    public sealed class DodgeSystem : MonoBehaviour
    {
        [SerializeField, Min(0f)]
        private float dodgeDistance = 3f;

        [SerializeField, Min(0f)]
        private float dodgeDuration = 0.2f;

        [SerializeField, Min(0f)]
        private float dodgeCooldown = 1f;

        private Rigidbody2D body;
        private Coroutine dodgeCoroutine;
        private bool bodyWasSimulated;
        private float nextDodgeTime;

        public bool IsInvincible { get; private set; }

        private void Awake()
        {
            body = GetComponent<Rigidbody2D>();
        }

        public void OnDodge()
        {
            Vector2 direction = body.velocity.sqrMagnitude > 0f
                ? body.velocity.normalized
                : (Vector2)transform.right;
            OnDodge(direction);
        }

        public void OnDodge(Vector2 moveDirection)
        {
            if (IsInvincible || Time.time < nextDodgeTime)
            {
                return;
            }

            Vector2 direction = moveDirection.sqrMagnitude > 0f
                ? moveDirection.normalized
                : Vector2.right;
            nextDodgeTime = Time.time + dodgeCooldown;
            dodgeCoroutine = StartCoroutine(DodgeRoutine(direction));
        }

        private IEnumerator DodgeRoutine(Vector2 direction)
        {
            bodyWasSimulated = body.simulated;
            body.simulated = false;
            IsInvincible = true;

            Vector2 startPosition = body.position;
            Vector2 endPosition = startPosition + direction * dodgeDistance;
            if (dodgeDuration <= 0f)
            {
                body.position = endPosition;
            }
            else
            {
                float elapsed = 0f;
                while (elapsed < dodgeDuration)
                {
                    elapsed += Time.deltaTime;
                    body.position = Vector2.Lerp(
                        startPosition,
                        endPosition,
                        Mathf.Clamp01(elapsed / dodgeDuration));
                    yield return null;
                }
            }

            FinishDodge();
        }

        private void FinishDodge()
        {
            if (body != null)
            {
                body.simulated = bodyWasSimulated;
                body.velocity = Vector2.zero;
            }

            IsInvincible = false;
            dodgeCoroutine = null;
        }

        private void OnDisable()
        {
            if (!IsInvincible)
            {
                return;
            }

            StopCoroutine(dodgeCoroutine);
            FinishDodge();
        }
    }
}
