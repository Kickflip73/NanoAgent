using EchoesOfAnotherWorld.Runtime.Input;
using EchoesOfAnotherWorld.Runtime.Echoes;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Actors
{
    [RequireComponent(typeof(Rigidbody2D))]
    [RequireComponent(typeof(PlayerInput))]
    [RequireComponent(typeof(CombatSystem))]
    [RequireComponent(typeof(DodgeSystem))]
    public sealed class PlayerController : MonoBehaviour
    {
        [SerializeField, Min(0f)]
        private float moveSpeed = 5f;

        private Rigidbody2D body;
        private PlayerInput playerInput;
        private CombatSystem combatSystem;
        private DodgeSystem dodgeSystem;
        private EchoContainer echoContainer;
        private Animator animator;
        private Vector2 facingDirection = Vector2.right;

        private void Awake()
        {
            body = GetComponent<Rigidbody2D>();
            playerInput = GetComponent<PlayerInput>();
            combatSystem = GetComponent<CombatSystem>();
            dodgeSystem = GetComponent<DodgeSystem>();
            echoContainer = GetComponent<EchoContainer>();
            animator = GetComponent<Animator>();
            body.freezeRotation = true;

            playerInput.AttackPressed += OnAttack;
            playerInput.DodgePressed += OnDodge;
            playerInput.SkillPressed += OnSkill;
            playerInput.NextEchoPressed += OnNextEcho;
        }

        private void Update()
        {
            Vector2 moveDirection = Vector2.ClampMagnitude(playerInput.MoveDirection, 1f);
            if (moveDirection != Vector2.zero)
            {
                facingDirection = moveDirection.normalized;
            }

            if (animator == null)
            {
                return;
            }

            Vector2 animationDirection = moveDirection == Vector2.zero
                ? Vector2.zero
                : new Vector2(
                    Mathf.Round(moveDirection.normalized.x),
                    Mathf.Round(moveDirection.normalized.y));

            animator.SetFloat("MoveX", animationDirection.x);
            animator.SetFloat("MoveY", animationDirection.y);
        }

        private void FixedUpdate()
        {
            if (dodgeSystem.IsInvincible)
            {
                return;
            }

            Vector2 moveDirection = Vector2.ClampMagnitude(playerInput.MoveDirection, 1f);
            body.velocity = moveDirection * moveSpeed;
        }

        private void OnDisable()
        {
            if (body != null)
            {
                body.velocity = Vector2.zero;
            }
        }

        private void OnDestroy()
        {
            if (playerInput == null)
            {
                return;
            }

            playerInput.AttackPressed -= OnAttack;
            playerInput.DodgePressed -= OnDodge;
            playerInput.SkillPressed -= OnSkill;
            playerInput.NextEchoPressed -= OnNextEcho;
        }

        private void OnAttack()
        {
            combatSystem.OnAttack(facingDirection);
        }

        private void OnDodge()
        {
            Vector2 moveDirection = Vector2.ClampMagnitude(playerInput.MoveDirection, 1f);
            dodgeSystem.OnDodge(moveDirection == Vector2.zero ? facingDirection : moveDirection);
        }

        private void OnSkill()
        {
            echoContainer?.UseSelected(facingDirection);
        }

        private void OnNextEcho()
        {
            echoContainer?.SelectNext();
        }
    }
}
